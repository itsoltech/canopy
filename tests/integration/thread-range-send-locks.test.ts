import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ThreadEventSchema, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { freezeThread } from "../../apps/gateway/src/computers/move-source.ts";
import { GatewayStore } from "../../apps/gateway/src/store/store.ts";
import { ingestThread } from "../../apps/gateway/src/store/ingest.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread publication, sends and moves lock ordering", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let store: ComputerStore;

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    // Pause a journal writer after it owns the global advisory lock, before
    // repeated clock updates recheck their FK. No production hook or timed sleep.
    await store.query(`CREATE TABLE range_clock_gate (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), thread_id uuid NOT NULL)`);
    await store.query(`CREATE FUNCTION pause_range_clock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM range_clock_gate WHERE thread_id=NEW.thread_id) THEN
          PERFORM pg_advisory_xact_lock(19273481,1);
        END IF;
        RETURN NEW;
      END $$`);
    await store.query(`CREATE TRIGGER pause_range_clock BEFORE UPDATE ON thread_replication_clock
      FOR EACH ROW EXECUTE FUNCTION pause_range_clock()`);
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

  async function clockGate(thread: string) {
    await store.query(
      `INSERT INTO range_clock_gate(thread_id) VALUES($1::uuid)
      ON CONFLICT(singleton) DO UPDATE SET thread_id=excluded.thread_id`,
      [thread],
    );
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

  async function blockedQuery(query: string, blocker?: number) {
    const pid = await eventually(
      async () =>
        (
          await store.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND state='active' AND wait_event_type='Lock' AND strpos(query,$1)>0
        AND ($2::integer IS NULL OR $2::integer=ANY(pg_blocking_pids(pid)))`,
            [query, blocker ?? null],
          )
        )[0]?.pid,
      (pid) => pid !== undefined,
    );

    expect(pid).toBeDefined();

    return pid!;
  }

  async function pausedPublisher(thread: string, gate: Awaited<ReturnType<typeof clockGate>>) {
    const gatePid = await gate.ready;
    const reading = readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));

    try {
      const pid = await blockedQuery("", gatePid);

      return { reading, pid };
    } catch (cause) {
      gate.release();
      await Promise.allSettled([reading, gate.done]);
      throw cause;
    }
  }

  function ingestNotice(thread: string) {
    return gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* ingestThread(sql, gateway.workerId, "lock-order-regression", thread, [
          create(ThreadEventSchema, {
            threadId: thread,
            eventId: crypto.randomUUID(),
            journalSeq: 1n,
            body: { case: "notice", value: { code: "lock_order", message: "Ingest committed" } },
          }),
        ]);
      }),
    );
  }

  test("command completion, ingest and SendMessage cannot cycle through the journal clock FK", async () => {
    const thread = await newThread();
    await gateway.api.sendMessage({
      threadId: thread,
      text: "before publication",
      clientRequestId: crypto.randomUUID(),
    });

    const command = await eventually(
      async () =>
        (
          await store.query<{ id: string }>(
            "SELECT c.id FROM worker_commands c JOIN turns t ON t.id=c.turn_id WHERE c.thread_id=$1::uuid AND c.status='completed' AND t.status='completed' LIMIT 1",
            [thread],
          )
        )[0],
      Boolean,
    );

    expect(command).toBeDefined();
    const initial = await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));
    const gate = await clockGate(thread);
    const gatePid = await gate.ready;

    const completing = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const outbox = yield* GatewayStore;
        yield* outbox.commandDone(command!.id, true, { regression: "journal clock FK" });
      }),
    );

    let ingesting: ReturnType<typeof ingestNotice> | undefined;
    let sending: ReturnType<typeof gateway.api.sendMessage> | undefined;

    try {
      // Completion owns global journal -> range barrier -> clock, paused before
      // the first UPDATE. Ingest owns threads and waits for that global lock.
      // SendMessage queues on ingest's tuple before completion rechecks its FK.
      const completingPid = await blockedQuery("UPDATE worker_commands SET status", gatePid);
      ingesting = ingestNotice(thread);
      const ingestingPid = await blockedQuery("COMMIT", completingPid);
      sending = gateway.api.sendMessage({
        threadId: thread,
        text: "after publication",
        clientRequestId: crypto.randomUUID(),
      });
      await blockedQuery("AND owner_user_id=", ingestingPid);
    } finally {
      gate.release();
      await Promise.allSettled([completing, ingesting, sending, gate.done]);
    }

    const [, , response] = await Promise.all([completing, ingesting, sending, gate.done]);

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
        epoch: initial.epoch,
        appliedSeq: initial.appliedSeq,
      }),
    );

    expect(next.headSeq).toBeGreaterThan(initial.headSeq);
    expect(next.caughtUp).toBe(true);
    expect(
      next.records.some((r) => r.value.case === "notice" && r.value.value.notice?.message === "Ingest committed"),
    ).toBe(true);
    expect(
      await store.query(
        "SELECT acked_seq::text FROM worker_journal_cursors WHERE thread_id=$1::uuid AND journal_id='lock-order-regression'",
        [thread],
      ),
    ).toEqual([{ acked_seq: "1" }]);
  }, 15_000);

  test("a move freezes before a queued SendMessage while range publication completes", async () => {
    const thread = await newThread();
    const gate = await clockGate(thread);
    const { reading, pid } = await pausedPublisher(thread, gate);

    const moving = freezeThread(store, {
      moveId: crypto.randomUUID(),
      threadId: thread,
      target: "a".repeat(64),
      placement: {},
    });

    let sending: Promise<string> | undefined;

    try {
      const movingPid = await blockedQuery("ORDER BY (id = ", pid);
      sending = failure(
        gateway.api.sendMessage({ threadId: thread, text: "during move", clientRequestId: crypto.randomUUID() }),
      );
      // The sender queues behind the move's tuple lock, not a wall-clock delay.
      await blockedQuery("AND owner_user_id=", movingPid);
    } finally {
      gate.release();
      await Promise.allSettled([reading, moving, sending, gate.done]);
    }

    const [batch, frozen, error] = await Promise.all([reading, moving, sending, gate.done]);

    expect(batch.caughtUp).toBe(true);
    expect(frozen.error).toBe("");
    // This fixture has no link router: admission is fenced by the database move
    // guard, whose SQL error is sanitized by the public RPC boundary.
    expect(error).not.toBe("");
    expect((await store.query("SELECT id FROM turns WHERE thread_id=$1::uuid", [thread])).length).toBe(0);
  }, 15_000);
});
