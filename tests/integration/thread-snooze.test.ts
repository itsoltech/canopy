import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { Provider, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const rpcCode = (call: Promise<object>) =>
  call.then(
    () => undefined,
    (cause) => ConnectError.from(cause).code,
  );

const inFuture = (ms: number) => timestampFromDate(new Date(Date.now() + ms));

async function* overviewHeaders(api: TestGateway["api"], threadId: string, signal: AbortSignal) {
  for await (const { change } of api.watchOverview({ includeSnapshot: true }, { signal, timeoutMs: 12_000 })) {
    if (change.case === "mobileSnapshot") {
      const thread = change.value.threads.find((row) => row.id === threadId);

      if (thread) yield thread;
    }

    if (change.case === "thread" && change.value.id === threadId) yield change.value;
  }
}

async function* sequenceHeaders(api: TestGateway["api"], threadId: string, signal: AbortSignal) {
  for await (const { change } of api.watchThread({ threadId, sequence: true }, { signal, timeoutMs: 12_000 })) {
    if (change.case === "snapshot" && change.value.thread) yield change.value.thread;

    if (change.case === "batch")
      for (const { value } of change.value.records)
        if (value.case === "thread" && value.value.id === threadId) yield value.value;
  }
}

async function nextHeader(headers: AsyncGenerator<ui.Thread>, predicate: (row: ui.Thread) => boolean) {
  while (true) {
    const result = await headers.next();

    if (result.done) throw new Error("watch ended before the thread update");

    if (predicate(result.value)) return result.value;
  }
}

describe.skipIf(!dockerAvailable)("thread snooze on the gateway", () => {
  let gateway: TestGateway | undefined;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gateway = await startTestGateway();
    projectId = (await gateway.api.createProject({ name: "Snooze" })).project!.id;
    workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/snooze" })
    ).workspace!.id;
  }, 60_000);
  afterAll(async () => gateway?.close(), 20_000);

  async function makeThread(title: string, parentThreadId = "") {
    const { api } = gateway!;

    const { thread } = await api.createThread({
      projectId,
      workspaceId,
      title,
      parentThreadId,
      provider: Provider.CODEX,
    });

    await eventually(
      () => api.getThread({ threadId: thread!.id }),
      ({ thread }) => thread?.status === "idle",
    );

    return thread!.id;
  }

  test("snoozes only the selected thread and leaves turns and read state available", async () => {
    const { api, worker } = gateway!;
    const threadId = await makeThread("Parent");
    const childId = await makeThread("User side thread", threadId);
    worker.holdTurns = true;

    try {
      await api.setThreadRead({ threadId, unread: true });
      expect((await api.setThreadSnooze({ threadId, snoozed: true })).thread).toMatchObject({
        snoozed: true,
        markedUnread: true,
        status: "idle",
      });
      const list = await api.listThreads({ projectId });
      expect(list.threads.find((row) => row.id === threadId)?.snoozed).toBe(true);
      expect(list.threads.find((row) => row.id === childId)?.snoozed).toBe(false);
      expect((await api.setThreadSnooze({ threadId: childId, snoozed: true })).thread?.snoozed).toBe(true);
      expect((await api.setThreadSnooze({ threadId, snoozed: false })).thread?.snoozed).toBe(false);
      expect((await api.getThread({ threadId: childId })).thread?.snoozed).toBe(true);
      await api.setThreadSnooze({ threadId, snoozed: true });

      const { turn } = await api.sendMessage({ threadId, text: "Keep working", clientRequestId: crypto.randomUUID() });
      await eventually(
        () => api.getThread({ threadId }),
        ({ thread }) => thread?.status === "running",
      );

      const result = await worker.callTool({
        threadId,
        turnId: turn!.id,
        tool: "spawn_thread",
        args: { title: "Subagent", prompt: "Continue", notify: false },
      });

      expect(result.isError).toBe(false);
      const { threads } = await api.listThreads({ projectId });
      const subagent = threads.find((row) => row.parentThreadId === threadId && row.spawnedByAgent);
      expect(subagent).toBeDefined();
      expect(await rpcCode(api.setThreadSnooze({ threadId: subagent!.id, snoozed: true }))).toBe(Code.InvalidArgument);
      expect((await api.getThread({ threadId })).thread).toMatchObject({ snoozed: true, status: "running" });

      await api.setThreadArchived({ threadId, archived: true });
      expect((await api.getThread({ threadId })).thread?.snoozed).toBe(false);
      expect(await rpcCode(api.setThreadSnooze({ threadId, snoozed: false }))).toBe(Code.InvalidArgument);
      expect((await api.setThreadArchived({ threadId, archived: false })).thread?.snoozed).toBe(true);
      await api.deleteThread({ threadId });
      expect(await rpcCode(api.setThreadSnooze({ threadId, snoozed: true }))).toBe(Code.NotFound);
    } finally {
      worker.holdTurns = false;
    }
  }, 20_000);

  test.each(["archive", "delete"])(
    "%s lets a side thread recheck its parent foreign keys",
    async (action) => {
      const { api, runtime, userId, secretsKey } = gateway!;
      const threadId = await makeThread(`Parent for ${action}`);
      const childId = await makeThread("Side thread with an in-flight write", threadId);
      const store = new ComputerStore(runtime, userId, secretsKey);
      const ready = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();

      const writer = runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE threads SET last_seq=last_seq WHERE id=${childId}::uuid`;
              ready.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
              yield* Effect.promise(() => release.promise);
              // PostgreSQL rechecks the parent reference when the same transaction updates the tuple twice.
              yield* sql`UPDATE threads SET last_seq=last_seq WHERE id=${childId}::uuid`;
            }),
          ),
        ),
      );

      void writer.catch(ready.reject);
      let closing: Promise<string> | undefined;

      try {
        const pid = await ready.promise;
        closing = failure(
          action === "archive"
            ? api.setThreadArchived({ threadId, archived: true }, { timeoutMs: 10_000 })
            : api.deleteThread({ threadId }, { timeoutMs: 10_000 }),
        );

        const blocked = await eventually(
          () =>
            store.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
              [pid],
            ),
          (rows) => rows.length === 1,
        );

        expect(blocked).toHaveLength(1);
      } finally {
        release.resolve();
        await Promise.allSettled([writer, closing]);
      }

      await writer;
      expect(await closing).toBe("");

      if (action === "archive") expect((await api.getThread({ threadId: childId })).thread?.status).toBe("archived");
      else expect(await rpcCode(api.getThread({ threadId: childId }))).toBe(Code.NotFound);
    },
    15_000,
  );

  test("validates deadlines and ownership, then publishes snooze and expiration to both feeds", async () => {
    const { api, core, runtime, userId, secretsKey } = gateway!;
    const threadId = await makeThread("Timed");
    const store = new ComputerStore(runtime, userId, secretsKey);
    const owner = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await store.query("INSERT INTO users (id,email,display_name,role) VALUES ($1::uuid,$2,'Other','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await store.query(
      `INSERT INTO threads (id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,title,status,snoozed,snoozed_until)
       VALUES ($1::uuid,$1::uuid,$2::uuid,$3::uuid,'main','gateway','anthropic','Foreign','idle',true,now()-interval '1 hour')`,
      [foreign, projectId, owner],
    );
    expect(await rpcCode(api.setThreadSnooze({ threadId: foreign, snoozed: false }))).toBe(Code.NotFound);
    expect(await rpcCode(api.setThreadSnooze({ threadId, snoozed: true, snoozedUntil: inFuture(-60_000) }))).toBe(
      Code.InvalidArgument,
    );

    const abort = new AbortController();
    const overview = overviewHeaders(api, threadId, abort.signal);
    const sequence = sequenceHeaders(api, threadId, abort.signal);

    try {
      await Promise.all([nextHeader(overview, (row) => !row.snoozed), nextHeader(sequence, (row) => !row.snoozed)]);
      const deadline = inFuture(3_000);
      const { thread } = await api.setThreadSnooze({ threadId, snoozed: true, snoozedUntil: deadline });

      if (!thread) throw new Error("Snooze response omitted the thread");
      expect(thread.snoozedUntil).toEqual(deadline);

      const sleeping = await Promise.all([
        nextHeader(overview, (row) => row.snoozed),
        nextHeader(sequence, (row) => row.snoozed),
      ]);

      for (const header of sleeping) expect(header.snoozedUntil).toEqual(deadline);
      core.snoozes.start();

      const awake = await Promise.all([
        nextHeader(overview, (row) => !row.snoozed),
        nextHeader(sequence, (row) => !row.snoozed),
      ]);

      for (const header of awake) {
        expect(header.snoozedUntil).toBeUndefined();
        expect(header.lastSeq).toBe(thread.lastSeq);
      }

      expect(await store.query("SELECT snoozed, snoozed_until FROM threads WHERE id=$1::uuid", [threadId])).toEqual([
        { snoozed: false, snoozed_until: null },
      ]);
      expect(await store.query("SELECT snoozed FROM threads WHERE id=$1::uuid", [foreign])).toEqual([
        { snoozed: true },
      ]);
    } finally {
      abort.abort();
      await Promise.allSettled([overview.return(undefined), sequence.return(undefined), core.snoozes.stop()]);
    }
  }, 20_000);

  test("startup clears a timed snooze that became due while offline and retains indefinite snooze", async () => {
    const threadId = await makeThread("Survives restart");
    const indefinite = await makeThread("Until woken");
    const previous = gateway!;
    const { pg, secretsKey, workerId, workerCredential } = previous;
    const deadline = inFuture(1_000);
    await previous.api.setThreadSnooze({ threadId: indefinite, snoozed: true });
    await previous.api.setThreadSnooze({ threadId, snoozed: true, snoozedUntil: deadline });
    await previous.close(true);
    gateway = undefined;

    try {
      await eventually(async () => Date.now() >= Number(deadline.seconds) * 1000 + deadline.nanos / 1_000_000, Boolean);
      gateway = await startTestGateway({ storage: { pg, secretsKey, workerId, workerCredential } });
    } finally {
      if (!gateway) await pg.stop();
    }

    const store = new ComputerStore(gateway.runtime, gateway.userId, secretsKey);
    const saved = () => store.query<{ snoozed: boolean }>("SELECT snoozed FROM threads WHERE id=$1::uuid", [threadId]);
    expect(await saved()).toEqual([{ snoozed: true }]);
    gateway.core.snoozes.start();
    await eventually(saved, ([row]) => row?.snoozed === false);
    expect((await gateway.api.getThread({ threadId })).thread?.snoozed).toBe(false);
    expect((await gateway.api.getThread({ threadId: indefinite })).thread?.snoozed).toBe(true);
  }, 45_000);
});
