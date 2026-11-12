import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { freezeThread } from "../../apps/gateway/src/computers/move-source.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread publication, sends and moves lock ordering", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let store: ComputerStore;

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    console.info(
      "Journal advisory key",
      await store.query("SELECT hashtextextended('canopy.thread_mirror_journal',0)::text AS key"),
    );
    // Pause bootstrap after its source-row/barrier locks, before the clock's FK
    // takes another KEY SHARE on threads. No production hook or timed sleep.
    await store.query(`CREATE FUNCTION pause_range_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(19273481,1); RETURN NEW; END $$`);
    await store.query(`CREATE TRIGGER pause_range_bootstrap BEFORE INSERT ON thread_replication_clock
      FOR EACH ROW EXECUTE FUNCTION pause_range_bootstrap()`);
  });

  afterAll(async () => {
    await gateway?.close();
  });

  async function newThread() {
    const project = (await gateway.api.createProject({ name: "Publication ordering" })).project!.id;
    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/locks" })
    ).workspace!.id;
    const thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Before publication",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
    await eventually(
      () => gateway.api.getThread({ threadId: thread }),
      (r) => r.thread?.status === "idle",
    );
    return thread;
  }

  function bootstrapGate() {
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const done = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(19273481,1)`;
            ready.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
            yield* Effect.promise(() => release.promise);
          }),
        );
      }),
    );
    return { ready: ready.promise, release: () => release.resolve(), done };
  }

  async function blockedQuery(query: string) {
    return eventually(
      async () =>
        (
          await store.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND state='active' AND wait_event_type='Lock' AND strpos(query,$1)>0`,
            [query],
          )
        )[0]?.pid,
      (pid) => pid !== undefined,
    );
  }

  async function pausedPublisher(thread: string, gatePid: number) {
    const reading = readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));
    await eventually(
      async () =>
        (
          await store.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked`,
            [gatePid],
          )
        )[0]!.blocked,
      Boolean,
    );
    return { reading };
  }

  test("a queued SendMessage cannot close a cycle between bootstrap FK and a source commit", async () => {
    const thread = await newThread();
    const gate = bootstrapGate();
    const { reading } = await pausedPublisher(thread, await gate.ready);
    const updating = store.query("UPDATE threads SET title='Committed during publication' WHERE id=$1::uuid", [thread]);
    let sending: ReturnType<typeof gateway.api.sendMessage> | undefined;
    try {
      await blockedQuery("UPDATE threads SET title");
      sending = gateway.api.sendMessage({
        threadId: thread,
        text: "after publication",
        clientRequestId: crypto.randomUUID(),
      });
      await blockedQuery("AND owner_user_id=");
    } finally {
      gate.release();
    }
    const [batch, , response] = await Promise.all([reading, updating, sending, gate.done]);
    expect(batch.caughtUp).toBe(true);
    expect(response?.turn).toBeDefined();
    expect(
      await eventually(
        async () => gateway.worker.inputs.get(thread) ?? [],
        (inputs) => inputs.includes("after publication"),
      ),
    ).toContain("after publication");
    const next = await readThreadRange(
      store,
      create(ui.ThreadSyncCursorSchema, {
        threadId: thread,
        epoch: batch.epoch,
        appliedSeq: batch.appliedSeq,
      }),
    );
    expect(next.headSeq).toBeGreaterThan(batch.headSeq);
    expect(
      next.records.some((r) => r.value.case === "thread" && r.value.value.title === "Committed during publication"),
    ).toBe(true);
  }, 15_000);

  test("a move freezes before a queued SendMessage while range publication completes", async () => {
    const thread = await newThread();
    const gate = bootstrapGate();
    const { reading } = await pausedPublisher(thread, await gate.ready);
    const moving = freezeThread(store, {
      moveId: crypto.randomUUID(),
      threadId: thread,
      target: "a".repeat(64),
      placement: {},
    });
    let sending: Promise<string> | undefined;
    try {
      await blockedQuery("ORDER BY (id = ");
      sending = failure(
        gateway.api.sendMessage({ threadId: thread, text: "during move", clientRequestId: crypto.randomUUID() }),
      );
      // The sender queues behind the move's tuple lock, not a wall-clock delay.
      await blockedQuery("AND owner_user_id=");
    } finally {
      gate.release();
    }
    const [batch, frozen, error] = await Promise.all([reading, moving, sending, gate.done]);
    expect(batch.caughtUp).toBe(true);
    expect(frozen.error).toBe("");
    expect(error).toContain("moving");
    expect((await store.query("SELECT id FROM turns WHERE thread_id=$1::uuid", [thread])).length).toBe(0);
  }, 15_000);
});
