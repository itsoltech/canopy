import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ThreadEventSchema, TurnOutcome, computerLink as link } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { ThreadMirror } from "../../apps/gateway/src/computers/mirror.ts";
import { commitMirrorUpdate, registerMirrorGeneration } from "../../apps/gateway/src/computers/mirror-persistence.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded database retention preserves durable state", () => {
  let gateway: TestGateway;
  let thread: string;

  const query = <T extends object = Record<string, string>>(text: string, args: readonly unknown[] = []) =>
    gateway.core.linkedAgents.query<T>(text, [...args]);

  const due = () =>
    query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [gateway.userId]);

  const prune = async () => {
    await due();

    return gateway.runtime.runPromise(pruneDatabase(gateway.userId));
  };

  beforeAll(async () => {
    gateway = await startTestGateway();
    const project = (await gateway.api.createProject({ name: "Retention" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/retention" })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("terminal command payloads compact in batches across restart, keeping receipts and live commands", async () => {
    await query(
      `INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,status,completed_at,expires_at,result)
      SELECT md5('retention-command-'||n)::uuid,$1::uuid,$2::uuid,'unloadThread',decode('0a00','hex'),'completed',now()-interval '8 days',now()+interval '1 day','{"receipt":true}'
      FROM generate_series(1,300) n`,
      [gateway.workerId, thread],
    );
    await query(
      `INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,status,completed_at,expires_at)
      SELECT md5('retention-live-'||n)::uuid,$1::uuid,$2::uuid,'unloadThread',decode('0a00','hex'),
      (ARRAY['pending','delivered','completed'])[n],now(),now()-interval '1 day' FROM generate_series(1,3) n`,
      [gateway.workerId, thread],
    );
    await prune();
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM worker_commands WHERE thread_id=$1::uuid AND payload_pruned_at IS NOT NULL",
          [thread],
        )
      )[0]?.n,
    ).toBe(256);
    const foreign = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Synthetic','user')", [
      foreign,
      `${foreign}@example.test`,
    ]);
    await gateway.runtime.runPromise(pruneDatabase(foreign));
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM worker_commands WHERE thread_id=$1::uuid AND payload_pruned_at IS NOT NULL",
          [thread],
        )
      )[0]?.n,
    ).toBe(256);

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage });
    await prune();
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM worker_commands WHERE thread_id=$1::uuid AND payload_pruned_at IS NOT NULL AND result->>'receipt'='true'",
          [thread],
        )
      )[0]?.n,
    ).toBe(300);
    expect(
      (
        await query<{ n: number }>(
          "SELECT count(*)::int n FROM worker_commands WHERE id IN (SELECT md5('retention-live-'||n)::uuid FROM generate_series(1,3)n) AND octet_length(payload)=2 AND payload_pruned_at IS NULL",
        )
      )[0]?.n,
    ).toBe(3);
  }, 30_000);

  test("rollback restores both pruning and the durable next-run marker", async () => {
    await query(
      "UPDATE worker_commands SET payload=decode('0a00','hex'),payload_pruned_at=NULL WHERE id=md5('retention-command-1')::uuid",
    );
    await due();
    await expect(
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* pruneDatabase(gateway.userId);

              return yield* Effect.fail(new Error("crash before commit"));
            }),
          );
        }),
      ),
    ).rejects.toThrow("crash before commit");
    expect(
      (
        await query<{ payload_pruned_at: string | null }>(
          "SELECT payload_pruned_at FROM worker_commands WHERE id=md5('retention-command-1')::uuid",
        )
      )[0]?.payload_pruned_at,
    ).toBeNull();
    expect(
      (
        await query<{ due: boolean }>(
          "SELECT next_run_at<=now() AS due FROM database_maintenance WHERE owner_user_id=$1::uuid",
          [gateway.userId],
        )
      )[0]?.due,
    ).toBe(true);
  });

  test("journal batches retain the resume window without changing its epoch, head or user history", async () => {
    const owner = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Synthetic','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await query("INSERT INTO computer_thread_clock(owner_user_id,revision) VALUES($1::uuid,10300)", [owner]);
    await query(
      "INSERT INTO computer_thread_changes(owner_user_id,revision) SELECT $1::uuid,n FROM generate_series(1,10300)n",
      [owner],
    );

    const before = (
      await query("SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid", [owner])
    )[0];

    await gateway.runtime.runPromise(pruneDatabase(owner));
    expect(
      (
        await query<{ n: number }>("SELECT count(*)::int n FROM computer_thread_changes WHERE owner_user_id=$1::uuid", [
          owner,
        ])
      )[0]?.n,
    ).toBe(10044);
    await query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [owner]);
    await gateway.runtime.runPromise(pruneDatabase(owner));
    expect(
      (
        await query<{ n: number }>("SELECT count(*)::int n FROM computer_thread_changes WHERE owner_user_id=$1::uuid", [
          owner,
        ])
      )[0]?.n,
    ).toBe(10000);
    expect(
      (await query("SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid", [owner]))[0],
    ).toEqual(before);
  });

  test("raw bot events prune only behind durable ACKs; terminal replay keeps its projection immutable", async () => {
    const bot = crypto.randomUUID();
    const turn = crypto.randomUUID();
    const command = crypto.randomUUID();
    await query(
      "INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) VALUES($1::uuid,$2::uuid,$1,'{}','codex','native')",
      [bot, gateway.userId],
    );
    await query(
      "INSERT INTO bot_turns(id,bot_id,client_request_id,input,status) VALUES($1::uuid,$2::uuid,$1,'synthetic','completed')",
      [turn, bot],
    );
    await query(
      "INSERT INTO worker_commands(id,worker_id,kind,payload,expires_at) VALUES($1::uuid,$2::uuid,'runBotTurn',''::bytea,now()+interval '1 day')",
      [command, gateway.workerId],
    );
    await query(
      "INSERT INTO bot_harness_turns(turn_id,bot_id,worker_id,command_id,outcome,text,finished_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,'durable answer',now()-interval '8 days')",
      [turn, bot, gateway.workerId, command],
    );
    await query(
      "INSERT INTO bot_harness_events(event_id,turn_id,worker_id,journal_id,journal_seq,payload) SELECT gen_random_uuid(),$1::uuid,$2::uuid,'retention',n,''::bytea FROM generate_series(1,300)n",
      [turn, gateway.workerId],
    );

    const replay = create(ThreadEventSchema, {
      eventId: crypto.randomUUID(),
      threadId: bot,
      turnId: turn,
      journalSeq: 300n,
      body: { case: "turnFinished", value: { outcome: TurnOutcome.FAILED } },
    });

    expect(await gateway.core.bots.run((s) => s.harnessEvent(gateway.workerId, "retention", replay))).toBe(true);
    await prune();
    expect(
      (await query<{ n: number }>("SELECT count(*)::int n FROM bot_harness_events WHERE turn_id=$1::uuid", [turn]))[0]
        ?.n,
    ).toBe(44);
    await prune();
    expect(
      (await query<{ n: number }>("SELECT count(*)::int n FROM bot_harness_events WHERE turn_id=$1::uuid", [turn]))[0]
        ?.n,
    ).toBe(0);
    replay.journalSeq = 500n;
    expect(await gateway.core.bots.run((s) => s.harnessEvent(gateway.workerId, "retention", replay))).toBe(true);
    expect((await gateway.core.bots.run((s) => s.harnessCursors(gateway.workerId, "retention")))[0]?.lastSeq).toBe(
      500n,
    );
    expect((await gateway.core.bots.run((s) => s.harnessTurn(turn)))?.text).toBe("durable answer");
    expect(
      (await query<{ n: number }>("SELECT count(*)::int n FROM bot_harness_events WHERE turn_id=$1::uuid", [turn]))[0]
        ?.n,
    ).toBe(0);
  });

  test("active and live staging generations survive, expired generations are fenced and removed in batches", async () => {
    const node = "retention-peer";
    await query(
      "INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint) VALUES($1::uuid,$2,'Synthetic','c','f')",
      [gateway.userId, node],
    );
    await query("INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES($1::uuid,$2)", [
      gateway.userId,
      node,
    ]);
    const mirror = new ThreadMirror(new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey));
    const state = (await mirror.state(node))!;
    const staging = crypto.randomUUID();
    expect(await gateway.runtime.runPromise(registerMirrorGeneration(gateway.userId, node, staging, state))).toBe(true);
    await query(
      "INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata) SELECT $1::uuid,$2,$3::uuid,gen_random_uuid(),''::bytea,''::bytea FROM generate_series(1,300)",
      [gateway.userId, node, staging],
    );
    await prune();
    expect(
      (
        await query<{ n: number }>("SELECT count(*)::int n FROM computer_mirror_threads WHERE generation=$1::uuid", [
          staging,
        ])
      )[0]?.n,
    ).toBe(300);
    await query(
      "UPDATE computer_mirror_generations SET lease_until=now()-interval '1 second' WHERE generation=$1::uuid",
      [staging],
    );

    const committed = await commitMirrorUpdate(
      gateway.runtime,
      gateway.userId,
      node,
      staging,
      state,
      create(link.MirrorUpdateSchema, { commit: true, cursor: `${crypto.randomUUID()}:1` }),
      null,
    );

    expect(committed).toBe(false);
    await prune();
    expect(
      (
        await query<{ n: number }>("SELECT count(*)::int n FROM computer_mirror_threads WHERE generation=$1::uuid", [
          staging,
        ])
      )[0]?.n,
    ).toBe(44);
    await prune();
    expect(
      (
        await query<{ n: number }>("SELECT count(*)::int n FROM computer_mirror_threads WHERE generation=$1::uuid", [
          staging,
        ])
      )[0]?.n,
    ).toBe(0);
    expect((await mirror.state(node))?.generation).toBe(state.generation);
  });
});
