import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ThreadEventSchema, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { freezeThread } from "../../apps/gateway/src/computers/move-source.ts";
import { ingestThread } from "../../apps/gateway/src/store/ingest.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

function moveLinks(gateway: TestGateway, store: ComputerStore) {
  const links = linkedComputers({
    store,
    host: "127.0.0.1",
    core: gateway.core,
    serve: remoteServe(uiHandlers(gateway.core), gateway.core),
  });

  gateway.core.computers = links;
  gateway.core.network = links.options.network;

  return links;
}

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
    // Hold the first StartTurn ACK until the clock gate is ready for its completion.
    const received = Promise.withResolvers<() => void>();
    gateway.worker.handlers.set("startTurn", (_, reply) => {
      gateway.worker.handlers.delete("startTurn");
      received.resolve(() => reply(true));
    });

    const first = await gateway.api.sendMessage({
      threadId: thread,
      text: "before publication",
      clientRequestId: crypto.randomUUID(),
    });

    const acknowledge = await received.promise;
    const initial = await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));
    const gate = await clockGate(thread);
    const gatePid = await gate.ready;

    let ingesting: ReturnType<typeof ingestNotice> | undefined;
    let sending: ReturnType<typeof gateway.api.sendMessage> | undefined;

    try {
      // Completion owns global journal -> range barrier -> clock, paused before
      // the first UPDATE. Ingest owns threads and waits for that global lock.
      // SendMessage queues on ingest's tuple before completion rechecks its FK.
      acknowledge();
      const completingPid = await blockedQuery("UPDATE worker_commands SET status", gatePid);
      ingesting = ingestNotice(thread);
      const ingestingPid = await blockedQuery("COMMIT", completingPid);
      sending = gateway.api.sendMessage({
        threadId: thread,
        text: "after publication",
        clientRequestId: crypto.randomUUID(),
      });
      // Identified by what blocks it, not by its SQL text: only the sender waits on ingest.
      await blockedQuery("", ingestingPid);
    } finally {
      gate.release();
      await Promise.allSettled([ingesting, sending, gate.done]);
    }

    const [, response] = await Promise.all([ingesting, sending, gate.done]);

    expect(response?.turn).toBeDefined();
    expect(
      await store.query("SELECT status FROM worker_commands WHERE kind='startTurn' AND turn_id=$1::uuid", [
        first.turn!.id,
      ]),
    ).toEqual([{ status: "completed" }]);
    gateway.worker.finish(thread, first.turn!.id);
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
      await blockedQuery("FROM threads", pid);
      sending = failure(
        gateway.api.sendMessage({ threadId: thread, text: "during move", clientRequestId: crypto.randomUUID() }),
      );
      // With both row locks held, PostgreSQL can report either transaction as the sender's blocker.
      await blockedQuery("AND purged_at IS NULL FOR UPDATE");
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

  test("StartMove lets a side thread finish rechecking its parent foreign keys", async () => {
    const parentId = await newThread();
    const { thread: parent } = await gateway.api.getThread({ threadId: parentId });

    const { thread: child } = await gateway.api.createThread({
      projectId: parent!.projectId,
      workspaceId: parent!.workspaceId,
      provider: Provider.CODEX,
      parentThreadId: parentId,
      title: "Side thread with an in-flight write",
    });

    const childId = child!.id;

    const ready = await eventually(
      () => gateway.api.getThread({ threadId: childId }),
      ({ thread }) => thread?.status === "idle",
    );

    expect(ready.thread?.status).toBe("idle");
    const target = await startTestGateway({ role: "desktop" });
    const sourceLinks = moveLinks(gateway, store);
    const targetLinks = moveLinks(target, new ComputerStore(target.runtime, target.userId, target.secretsKey));

    try {
      await Promise.all([sourceLinks.start(), targetLinks.start()]);
      const nodeId = targetLinks.hello().nodeId;
      const invitation = await target.api.createComputerPairing({});
      await gateway.api.linkComputer({ address: targetLinks.addresses[0]!, code: invitation.code });
      expect(await eventually(async () => sourceLinks.reachable().includes(nodeId), Boolean, 15_000)).toBe(true);

      const project = (await target.api.createProject({ name: "Move target" })).project!;

      const workspace = (
        await target.api.createWorkspace({ projectId: project.id, workerId: target.workerId, rootPath: "/repo/move" })
      ).workspace!;

      const locked = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();

      const writer = gateway.runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE threads SET last_seq=last_seq WHERE id=${childId}::uuid`;
              locked.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
              yield* Effect.promise(() => release.promise);
              // Like worker ingest, a second update in the same transaction rechecks the parent FK.
              yield* sql`UPDATE threads SET last_seq=last_seq WHERE id=${childId}::uuid`;
            }),
          ),
        ),
      );

      void writer.catch(locked.reject);
      let moving: Promise<ui.MovesSnapshot> | undefined;
      let waiting: Promise<number> | undefined;

      try {
        const pid = await locked.promise;
        moving = gateway.api.startMove(
          {
            nodeId,
            items: [{ kind: "thread", id: parentId }],
            placements: [{ projectId: parent!.projectId, workspaceId: qualifyId(workspace.id, nodeId) }],
          },
          { timeoutMs: 10_000 },
        );

        waiting = blockedQuery("FROM threads", pid);
        await Promise.race([
          waiting,
          moving.then(() => {
            throw new Error("StartMove completed before waiting on the side-thread writer");
          }),
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([waiting, moving, writer]);
      }

      const [started] = await Promise.all([moving, writer]);
      const move = started?.moves[0];
      expect(move?.itemId).toBe(parentId);

      const arrived = await eventually(
        async () => (await target.api.getMoves({})).moves.find((record) => record.id === move?.id),
        (record) => record?.state === "done",
        15_000,
      );

      expect(arrived).toMatchObject({ state: "done", error: "" });
      expect((await target.api.getThread({ threadId: childId })).thread?.parentThreadId).toBe(parentId);
    } finally {
      await Promise.allSettled([sourceLinks.close(), targetLinks.close()]);
      delete gateway.core.computers;
      delete gateway.core.network;
      await target.close();
    }
  }, 45_000);
});
