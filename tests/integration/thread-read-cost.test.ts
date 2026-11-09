import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect, Tracer } from "effect";
import { SqlClient } from "effect/sql";
import { threadWindow } from "../../apps/gateway/src/store/thread-window.ts";
import { threadWatchRevision } from "../../apps/gateway/src/store/thread-watch-revision.ts";
import { UpdatePersistence } from "../../apps/gateway/src/updates/persistence.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mirrorJournal } from "../../apps/gateway/src/computers/mirror-journal.ts";
import { mirrorSelection } from "../../apps/gateway/src/store/mirror-selection.ts";
import { coreBroadcastThread, coreBroadcastTurn } from "../../apps/gateway/src/core/core-broadcast.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded metadata reads on PostgreSQL", () => {
  let gateway: TestGateway;
  let thread: string;

  const query = <A extends object>(text: string, params: unknown[] = []) =>
    gateway.core.linkedAgents.query<A>(text, params);

  beforeAll(async () => {
    gateway = await startTestGateway();
    const project = (await gateway.api.createProject({ name: "Read costs" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project,
        workerId: gateway.workerId,
        rootPath: "/repo/read-costs",
      })
    ).workspace!.id;

    thread = (await gateway.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX }))
      .thread!.id;
  });
  afterAll(async () => {
    await gateway?.close();
  });

  async function projectsWithQueryCount() {
    const spans: Tracer.Span[] = [];

    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);

        return span;
      },
    });

    const projects = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.listProjects(gateway.userId)).pipe(Effect.withTracer(tracer)),
    );

    return { projects, count: spans.filter((s) => s.attributes.has("db.query.text")).length };
  }

  test("scratch reconciliation has constant read count and preserves owner scoping and root changes", async () => {
    const before = await projectsWithQueryCount();
    expect(before.count).toBeGreaterThan(0);
    await query(
      `WITH added AS (
      INSERT INTO workers(id,owner_user_id,name,credential_hash,capabilities,os)
      SELECT gen_random_uuid(),$1::uuid,'Worker '||n,gen_random_uuid()::text,
        '{"scratchRoot":"/data/scratch"}'::jsonb,'linux' FROM generate_series(1,100) n RETURNING id
    ) INSERT INTO worker_configs(worker_id,version,config,updated_by)
      SELECT id,1,'{}'::jsonb,$1::uuid FROM added`,
      [gateway.userId],
    );
    const provisioned = await projectsWithQueryCount();
    const after = await projectsWithQueryCount();
    const scratch = after.projects.find((p) => p.kind === "scratch")!;
    expect(scratch.workspaces).toHaveLength(101);
    expect(provisioned.count - after.count).toBe(100);
    expect(after.count).toBe(before.count);
    await query(
      `UPDATE workers SET capabilities=jsonb_set(capabilities,'{scratchRoot}','"/changed/scratch"')
      WHERE name='Worker 1' AND owner_user_id=$1::uuid`,
      [gateway.userId],
    );
    const changed = await projectsWithQueryCount();
    expect(
      changed.projects
        .find((p) => p.kind === "scratch")!
        .workspaces.some((w) => w.rootPath === `/changed/scratch/${gateway.userId}`),
    ).toBe(true);

    const other = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("read-cost-other@test", "Other")),
    );

    const otherProjects = await gateway.runtime.runPromise(GatewayStore.use((s) => s.listProjects(other)));
    expect(otherProjects.flatMap((p) => p.workspaces)).toEqual([]);
    console.info("Scratch overview measurement", {
      workers: 101,
      legacyQueries: before.count + 100,
      queries: after.count,
    });
  });

  test("worker and update listings omit large unrelated JSON and retain profile names", async () => {
    await query(
      `UPDATE worker_configs SET version=version+1,
      config=jsonb_build_object('profiles',jsonb_build_array(jsonb_build_object('id','named','displayName','My profile')),
        'instructions',repeat('x',20*1024*1024)),
      apply_report='{"profiles":[{"id":"named","provider":"PROVIDER_CODEX","available":true}]}'::jsonb
      WHERE worker_id=$1::uuid`,
      [gateway.workerId],
    );
    await query(
      `UPDATE workers SET capabilities=capabilities || jsonb_build_object(
      'unrelated',repeat('x',20*1024*1024),'updateCommand',jsonb_build_object('invalid','ignored by snapshot'))
      WHERE id=$1::uuid`,
      [gateway.workerId],
    );
    const workers = await gateway.runtime.runPromise(GatewayStore.use((s) => s.listWorkers(new Set(), gateway.userId)));
    expect(workers.find((w) => w.id === gateway.workerId)?.profiles[0]?.displayName).toBe("My profile");
    const updates = await new UpdatePersistence(gateway.runtime, gateway.userId).workers(false);
    expect(updates.find((w) => w.id === gateway.workerId)?.command).toBeUndefined();

    const sizes = await query<{ config: number; names: number; capabilities: number }>(
      `SELECT
      octet_length(config::text) AS config,
      octet_length((SELECT jsonb_object_agg(p->>'id',p->>'displayName') FROM jsonb_array_elements(config->'profiles') p)::text) AS names,
      (SELECT octet_length(capabilities::text) FROM workers WHERE id=$1::uuid) AS capabilities
      FROM worker_configs WHERE worker_id=$1::uuid`,
      [gateway.workerId],
    );

    expect(sizes[0]!.config).toBeGreaterThan(20 * 1024 * 1024);
    expect(sizes[0]!.names).toBeLessThan(100);
    console.info("Worker metadata measurement", sizes[0]);
  });

  test("large histories use an indexed activity lookup and transfer only the requested turn window", async () => {
    await query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq,queued_at,completed_at)
      SELECT gen_random_uuid(),$1::uuid,n,'completed','user',$2::uuid,'{}',n*2-1,n*2,
        '2026-01-01'::timestamptz+n*interval '1 second','2026-01-01'::timestamptz+n*interval '2 seconds'
      FROM generate_series(1,10000) n`,
      [thread, gateway.userId],
    );
    await query("ANALYZE turns");
    const activity = "greatest(queued_at,coalesce(started_at,queued_at),coalesce(completed_at,queued_at))";

    const legacy = await query<{ latest: Date }>(
      `SELECT max(${activity}) AS latest FROM turns WHERE thread_id=$1::uuid`,
      [thread],
    );

    const latest = await query<{ latest: Date }>(
      `SELECT ${activity} AS latest FROM turns WHERE thread_id=$1::uuid ORDER BY ${activity} DESC LIMIT 1`,
      [thread],
    );

    expect(latest[0]!.latest).toEqual(legacy[0]!.latest);

    const plan = await query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE) SELECT ${activity} FROM turns WHERE thread_id=$1::uuid ORDER BY ${activity} DESC LIMIT 1`,
      [thread],
    );

    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("turns_last_activity");
    const oldStart = performance.now();
    const all = await query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1::uuid ORDER BY ordinal", [thread]);
    const oldMs = performance.now() - oldStart;
    const started = performance.now();

    const window = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        return yield* threadWindow(
          yield* SqlClient.SqlClient,
          thread,
          "version",
          create(ui.WatchThreadRequestSchema, { pageSize: 24 }),
        );
      }),
    );

    expect(window?.ids).toEqual(all.slice(-24).map((r) => r.id));
    expect(window?.hasMore).toBe(true);
    console.info("History window measurement", {
      turns: all.length,
      legacyMs: Math.round(oldMs),
      windowMs: Math.round(performance.now() - started),
      legacyIdBytes: all.length * 36,
      windowIdBytes: window!.ids.length * 36,
      activityPlan: plan.map((r) => r["QUERY PLAN"]),
    });
  }, 30_000);

  test("thread lists, headers and watch snapshots omit instructions and title context", async () => {
    await query(
      `UPDATE threads SET settings=jsonb_build_object('model','model','effort','high','permissionMode','ASK',
      'instructions',repeat('x',20*1024*1024)),title_context=repeat('y',20*1024*1024) WHERE id=$1::uuid`,
      [thread],
    );
    const rows = await gateway.runtime.runPromise(GatewayStore.use((s) => s.listThreads(gateway.userId, "")));
    expect(rows.find((t) => t.id === thread)?.settings).toEqual({
      model: "model",
      effort: "high",
      permissionMode: "ASK",
    });
    expect(rows.find((t) => t.id === thread)?.title_context).toBe("");
    expect((await gateway.api.getThread({ threadId: thread })).thread?.model).toBe("model");
    await coreBroadcastThread(gateway.core, thread);

    const snapshot = await gateway.runtime.runPromise(
      GatewayStore.use((s) =>
        s.snapshot(thread, undefined, true, create(ui.WatchThreadRequestSchema, { pageSize: 24 })),
      ),
    );

    expect(snapshot.thread.title_context).toBe("");
    expect(snapshot.thread.settings.instructions).toBeUndefined();
    console.info("Thread list measurement", {
      omittedBytesPerThread: 40 * 1024 * 1024,
      settingsBytes: JSON.stringify(rows.find((t) => t.id === thread)!.settings).length,
    });
    await query("UPDATE threads SET settings='{}'::jsonb,title_context='' WHERE id=$1::uuid", [thread]);
  });

  test("turn broadcasts fetch one turn without reading another turn's large input", async () => {
    const last = (
      await query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1::uuid ORDER BY ordinal DESC LIMIT 1", [
        thread,
      ])
    )[0]!.id;

    await query(
      "UPDATE turns SET input=jsonb_build_object('text',repeat('x',20*1024*1024)) WHERE thread_id=$1::uuid AND ordinal=1",
      [thread],
    );
    const subscription = gateway.core.hub.subscribeThread(thread);

    try {
      await coreBroadcastTurn(gateway.core, thread, last);
      const next = await subscription.updates[Symbol.asyncIterator]().next();
      expect(next.value?.change).toMatchObject({ case: "turn", value: { id: last } });
      console.info("Turn broadcast measurement", {
        legacyTurnRows: 10000,
        turnRows: 1,
        omittedInputBytes: 20 * 1024 * 1024,
      });
    } finally {
      subscription.close();
    }

    await query("UPDATE turns SET input='{}'::jsonb WHERE thread_id=$1::uuid AND ordinal=1", [thread]);
  });

  test("moved history hashes backfill once and stay current after updates", async () => {
    await query(
      `INSERT INTO computer_moved_threads(thread_id,from_node_id,history,ordinal_turn_id)
      VALUES($1::uuid,'peer',repeat('x',8*1024*1024)::bytea,gen_random_uuid())`,
      [thread],
    );

    const before = await query<{ matches: boolean }>(
      "SELECT history_hash=md5(history) AS matches FROM computer_moved_threads WHERE thread_id=$1::uuid",
      [thread],
    );

    expect(before[0]?.matches).toBe(true);
    // Recreate the column over existing rows, exercising the migration's stored-column backfill.
    await query("ALTER TABLE computer_moved_threads DROP COLUMN history_hash");
    await query(
      "ALTER TABLE computer_moved_threads ADD COLUMN history_hash text GENERATED ALWAYS AS (md5(history)) STORED",
    );

    const plan = await query<{ "QUERY PLAN": string }>(
      "EXPLAIN (ANALYZE,BUFFERS) SELECT history_hash FROM computer_moved_threads WHERE thread_id=$1::uuid",
      [thread],
    );

    await query("UPDATE computer_moved_threads SET history='changed'::bytea WHERE thread_id=$1::uuid", [thread]);

    const after = await query<{ matches: boolean; changed: boolean }>(
      "SELECT history_hash=md5(history) AS matches,history_hash<>md5(repeat('x',8*1024*1024)::bytea) AS changed FROM computer_moved_threads WHERE thread_id=$1::uuid",
      [thread],
    );

    expect(after[0]).toEqual({ matches: true, changed: true });
    console.info("Moved history measurement", {
      legacyHashBytes: 8 * 1024 * 1024,
      storedHashBytes: 32,
      plan: plan.map((r) => r["QUERY PLAN"]),
    });
    await query("DELETE FROM computer_moved_threads WHERE thread_id=$1::uuid", [thread]);
  });

  test("watch heartbeats ignore unrelated threads and recover relevant changes and pruned journals", async () => {
    const clock = (
      await query<{ epoch: string; revision: string }>(
        "SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
        [gateway.userId],
      )
    )[0]!;

    const read = () =>
      query<{ epoch: string; revision: string; relevant: string; count: string }>(threadWatchRevision, [
        gateway.userId,
        [thread],
        clock.revision,
      ]);

    const other = crypto.randomUUID();
    await query(
      `INSERT INTO computer_thread_changes(owner_user_id,revision,thread_id,entity_kind,entity_id)
      VALUES($1::uuid,$2::bigint+1,$3::uuid,'threads',$3)`,
      [gateway.userId, clock.revision, other],
    );
    await query("UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=$1::uuid", [gateway.userId]);
    expect((await read())[0]!.relevant).toBe("0");
    expect((await read())[0]!.count).toBe("1");
    await query("UPDATE threads SET title='Relevant revision' WHERE id=$1::uuid", [thread]);
    expect(BigInt((await read())[0]!.relevant)).toBeGreaterThan(BigInt(clock.revision));
    await query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid", [gateway.userId]);
    expect((await read())[0]!.count).toBe("0");
    expect(BigInt((await read())[0]!.revision)).toBeGreaterThan(BigInt(clock.revision));
  });

  test("mirror sync coalesces repeated keys in SQL and a thread delta omits unrelated journal rows", async () => {
    const clock = (
      await query<{ epoch: string; revision: string }>(
        "SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
        [gateway.userId],
      )
    )[0]!;

    const other = crypto.randomUUID();
    await query(
      `INSERT INTO computer_thread_changes(owner_user_id,revision,thread_id,entity_kind,entity_id)
      SELECT $1::uuid,$2::bigint+n,$3::uuid,'thread_items','item' FROM generate_series(1,1000) n`,
      [gateway.userId, clock.revision, other],
    );
    await query("UPDATE computer_thread_clock SET revision=revision+1000 WHERE owner_user_id=$1::uuid", [
      gateway.userId,
    ]);
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const changes = await mirrorJournal(store, clock.revision, (BigInt(clock.revision) + 1000n).toString());
    expect(changes).toEqual({ count: "1000", threads: [other] });

    const selection = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        return yield* mirrorSelection(
          yield* SqlClient.SqlClient,
          gateway.userId,
          thread,
          `${clock.epoch}:${clock.revision}`,
        );
      }),
    );

    expect(selection).toEqual({ itemIds: [], turnIds: [], noticeSeqs: [] });
    await query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid AND revision=$2::bigint+1", [
      gateway.userId,
      clock.revision,
    ]);
    const gap = await mirrorJournal(store, clock.revision, (BigInt(clock.revision) + 1000n).toString());
    expect(gap.count).toBe("999");
    console.info("Mirror journal measurement", {
      changes: 1000,
      oldRows: 1000,
      syncKeys: changes.threads.length,
      threadDeltaKeys: selection!.itemIds.length,
    });
  });
});
