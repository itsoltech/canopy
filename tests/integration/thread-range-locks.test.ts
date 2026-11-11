import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { readThreadRange } from "../../apps/gateway/src/computers/range-source.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread range source commit ordering", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop" });
  });

  afterAll(async () => {
    await gateway?.close();
  });

  async function newThread() {
    const project = (await gateway.api.createProject({ name: "Commit ordering" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/locks" })
    ).workspace!.id;

    const thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Before commit",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    await eventually(
      () => gateway.api.getThread({ threadId: thread }),
      (value) => value.thread?.status === "idle",
    );

    return thread;
  }

  test("bootstrap waits for a locked source row before taking its journal barrier", async () => {
    const thread = await newThread();
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const locked = Promise.withResolvers<number>();
    const commit = Promise.withResolvers<void>();

    const writer = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM threads WHERE id=${thread}::uuid FOR UPDATE`;
            yield* sql`UPDATE threads SET title='After commit' WHERE id=${thread}::uuid`;
            const rows = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            locked.resolve(rows[0]!.pid);
            yield* Effect.promise(() => commit.promise);
          }),
        );
      }),
    );

    const pid = await locked.promise;
    const reading = readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));

    try {
      // The reader has reached the held row. Releasing the source now used to
      // deadlock its deferred trigger against bootstrap's foreign-key insert.
      expect(
        await eventually(
          async () =>
            (
              await store.query<{ blocked: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked",
                [pid],
              )
            )[0]!.blocked,
          Boolean,
        ),
      ).toBe(true);
    } finally {
      commit.resolve();
    }

    const [, batch] = await Promise.all([writer, reading]);
    expect(batch.caughtUp).toBe(true);
    const metadata = batch.records.find((record) => record.value.case === "thread");
    expect(metadata?.value.case === "thread" && metadata.value.value.title).toBe("After commit");
    expect(batch.remaining).toBe(0n);
  }, 15_000);

  test("dependency invalidation takes the global journal lock before per-thread barriers", async () => {
    const thread = await newThread();
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));
    const locked = Promise.withResolvers<number>();
    const commit = Promise.withResolvers<void>();

    const journal = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0))`;
            const rows = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            locked.resolve(rows[0]!.pid);
            yield* Effect.promise(() => commit.promise);
            yield* sql`SELECT thread_replication_touch(${thread}::uuid,'thread',${thread})`;
          }),
        );
      }),
    );

    const pid = await locked.promise;

    const dependency = gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // A worktree dependency can be invalidated before a later source
            // change in the same transaction reaches computer_thread_changed.
            yield* sql`SELECT thread_replication_touch(${thread}::uuid,'thread',${thread})`;
            yield* sql`UPDATE threads SET title='Dependency committed' WHERE id=${thread}::uuid`;
          }),
        );
      }),
    );

    try {
      expect(
        await eventually(
          async () =>
            (
              await store.query<{ blocked: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked",
                [pid],
              )
            )[0]!.blocked,
          Boolean,
        ),
      ).toBe(true);
    } finally {
      commit.resolve();
    }

    await Promise.all([journal, dependency]);
    const batch = await readThreadRange(store, create(ui.ThreadSyncCursorSchema, { threadId: thread }));
    const metadata = batch.records.findLast((record) => record.value.case === "thread");
    expect(metadata?.value.case === "thread" && metadata.value.value.title).toBe("Dependency committed");
    expect(batch.caughtUp).toBe(true);
  }, 15_000);
});
