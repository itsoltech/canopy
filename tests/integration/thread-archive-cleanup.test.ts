import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, GoalStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread archive resource cleanup", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";

  const query = <A extends object>(statement: string, params: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(statement, params);
      }),
    );

  const thread = async (title: string, parentThreadId = "") => {
    const created = (
      await gw.api.createThread({ projectId, workspaceId, title, parentThreadId, provider: Provider.CODEX })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: created.id }),
      (r) => r.thread?.status === "idle",
    );

    return created;
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Archive cleanup" })).project!.id;
    workspaceId = (
      await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/archive-cleanup" })
    ).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  }, 30_000);

  const seedPending = async (threadId: string, turnId: string) => {
    const pr = Bun.randomUUIDv7();
    const watch = Bun.randomUUIDv7();
    await query(
      `INSERT INTO github_pull_requests(id,owner_user_id,repository_id,repository_name,number,node_id,created_at)
      VALUES ($1::uuid,$2::uuid,$1,'canopy/cleanup',1,$1,now())`,
      [pr, gw.userId],
    );
    await query(
      `INSERT INTO pr_check_watches(id,owner_user_id,thread_id,pull_request_id,call_id,notify_on,hops,expires_at,head_sha)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$1::uuid,ARRAY['failure'],1,now()+interval '1 hour','head')`,
      [watch, gw.userId, threadId, pr],
    );
    await query(
      `INSERT INTO pr_check_notes(id,watch_id,thread_id,body,wake,hops)
      VALUES ($1::uuid,$2::uuid,$3::uuid,'{}',false,1)`,
      [Bun.randomUUIDv7(), watch, threadId],
    );
    await query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES ($1::uuid,'bg:waiting','background_task','completed','{}',0,0)`,
      [threadId],
    );
    await query(
      `INSERT INTO background_task_notes(thread_id,item_id,wake,ended_at,hops)
      VALUES ($1::uuid,'bg:waiting',false,now(),1)`,
      [threadId],
    );
    await query(
      `INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$1::uuid,'Pending credential','test')`,
      [Bun.randomUUIDv7(), threadId, turnId],
    );
    await query(
      `INSERT INTO goals(id,thread_id,objective,status,created_by,native_status)
      VALUES($1::uuid,$2::uuid,'Retained objective','active','provider','active')`,
      [Bun.randomUUIDv7(), threadId],
    );
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueCommand({
          workerId: gw.workerId,
          threadId,
          ttlSeconds: 86400,
          command: { kind: { case: "createThread", value: { thread: { threadId } } } },
        }),
      ),
    );

    return (
      await gw.api.createSchedule({
        threadId,
        prompt: "later",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 3_600_000)) },
      })
    ).schedule!;
  };

  test("archiving cancels a start whose delivery is waiting for the thread", async () => {
    const { id: threadId } = await thread("Archive versus start delivery");

    const command = await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const turn = yield* store.enqueueTurn({
                threadId,
                userId: gw.userId,
                text: "Start",
                clientRequestId: "",
              });

              return yield* store.enqueueCommand({
                workerId: gw.workerId,
                threadId,
                turnId: turn.id,
                ttlSeconds: 3600,
                command: { kind: { case: "startTurn", value: { thread: { threadId }, turnId: turn.id } } },
              });
            }),
          ),
        ),
      ),
    );

    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();

    const archive = gw.runtime.runPromise(
      GatewayStore.use((store) =>
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM threads WHERE id=${threadId}::uuid FOR NO KEY UPDATE`;
              locked.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
              yield* Effect.promise(() => release.promise);
              yield* store.setThreadArchived(gw.userId, threadId, true);
            }),
          ),
        ),
      ),
    );

    void archive.catch(locked.reject);
    let delivery: Promise<boolean | undefined> | undefined;

    try {
      const pid = await locked.promise;
      delivery = gw.runtime.runPromise(GatewayStore.use((store) => store.sendPending(command, () => true)));
      let deliverySettled = false;
      const markSettled = () => (deliverySettled = true);
      void delivery.then(markSettled, markSettled);

      const blocked = await eventually(
        () =>
          query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
            [String(pid)],
          ),
        (rows) => deliverySettled || rows.length > 0,
      );

      expect(blocked).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([archive, delivery]);
    }

    await archive;
    expect(await delivery).toBeUndefined();
    expect(await query("SELECT status FROM worker_commands WHERE id=$1::uuid", [command.commandId])).toEqual([
      { status: "expired" },
    ]);
  }, 15_000);

  for (const operation of ["archive", "delete", "agent"] as const) {
    test(`${operation} cancels every pending delivery and unloads an idle thread`, async () => {
      const parent = await thread(`Caller ${operation}`);
      const target = await thread(`Resources ${operation}`, parent.id);

      const sent = (
        await gw.api.sendMessage({ threadId: target.id, text: "finish", clientRequestId: Bun.randomUUIDv7() })
      ).turn!;

      await eventually(
        () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [sent.id]),
        (rows) => rows[0]?.status === "completed",
      );
      const schedule = await seedPending(target.id, sent.id);

      if (operation === "archive") await gw.api.setThreadArchived({ threadId: target.id, archived: true });
      else if (operation === "delete") await gw.api.deleteThread({ threadId: target.id });
      else
        expect(
          (await gw.worker.callTool({ threadId: parent.id, tool: "close_thread", args: { thread_id: target.id } }))
            .isError,
        ).toBe(false);

      expect(
        await query("SELECT status,end_reason FROM pr_check_watches WHERE thread_id=$1::uuid", [target.id]),
      ).toEqual([{ status: "ended", end_reason: "thread_closed" }]);
      expect(await query("SELECT status,last_reason FROM goals WHERE thread_id=$1::uuid", [target.id])).toEqual([
        { status: "paused", last_reason: "thread closed" },
      ]);
      expect(await query("SELECT status FROM pr_check_notes WHERE thread_id=$1::uuid", [target.id])).toEqual([
        { status: "cancelled" },
      ]);
      expect(await query("SELECT status FROM background_task_notes WHERE thread_id=$1::uuid", [target.id])).toEqual([
        { status: "cancelled" },
      ]);
      expect(await query("SELECT status,revision FROM thread_secrets WHERE thread_id=$1::uuid", [target.id])).toEqual([
        { status: "expired", revision: 1 },
      ]);
      expect(
        await query(
          "SELECT status FROM worker_commands WHERE thread_id=$1::uuid AND kind='createThread' ORDER BY created_at DESC LIMIT 1",
          [target.id],
        ),
      ).toEqual([{ status: "expired" }]);
      expect(await query("SELECT status FROM schedules WHERE id=$1::uuid", [schedule.id])).toEqual([
        { status: "cancelled" },
      ]);
      await eventually(
        () =>
          query<{ status: string }>(
            "SELECT status FROM worker_commands WHERE thread_id=$1::uuid AND kind='unloadThread'",
            [target.id],
          ),
        (rows) => rows[0]?.status === "completed",
      );
      expect(gw.worker.commands.some((c) => c.case === "unloadThread" && c.value.threadId === parent.id)).toBe(false);

      if (operation === "delete") await gw.api.restoreThread({ threadId: target.id });
      else await gw.api.setThreadArchived({ threadId: target.id, archived: false });
      await gw.core.backgroundTasks.tick();
      await gw.core.checkWatches.tick();
      expect(await query("SELECT id FROM turns WHERE thread_id=$1::uuid", [target.id])).toHaveLength(1);

      const goal = (await query<{ id: string }>("SELECT id FROM goals WHERE thread_id=$1::uuid", [target.id]))[0]!;
      // The failed command may have crossed the archive boundary before its ACK was handled.
      await gw.runtime.runPromise(GoalStore.use((s) => s.commandFailed(goal.id, "late command failure")));

      const next = (
        await gw.api.sendMessage({ threadId: target.id, text: "Continue", clientRequestId: Bun.randomUUIDv7() })
      ).turn!;

      await eventually(
        () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [next.id]),
        (rows) => rows[0]?.status === "completed",
      );
      expect(await query("SELECT status FROM goals WHERE thread_id=$1::uuid", [target.id])).toEqual([
        { status: "paused" },
      ]);
    });
  }

  test("retention keeps an offline thread until even an expired unload is acknowledged", async () => {
    const target = await thread("Offline cleanup retention");
    let acknowledge: (() => void) | undefined;
    gw.worker.handlers.set("unloadThread", (_value, reply) => {
      acknowledge = () => reply(true);
    });

    try {
      await gw.api.deleteThread({ threadId: target.id });
      await eventually(async () => acknowledge !== undefined, Boolean);
      await query("UPDATE threads SET deleted_at=now()-interval '32 days' WHERE id=$1::uuid", [target.id]);
      await query(
        "UPDATE worker_commands SET expires_at=now()-interval '2 days' WHERE thread_id=$1::uuid AND kind='unloadThread'",
        [target.id],
      );
      await query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [gw.userId]);
      await gw.runtime.runPromise(pruneDatabase(gw.userId));
      expect(await query("SELECT purged_at FROM threads WHERE id=$1::uuid", [target.id])).toEqual([
        { purged_at: null },
      ]);
      acknowledge!();
      await eventually(
        () =>
          query<{ status: string }>(
            "SELECT status FROM worker_commands WHERE thread_id=$1::uuid AND kind='unloadThread'",
            [target.id],
          ),
        (rows) => rows[0]?.status === "completed",
      );
      await query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [gw.userId]);
      await gw.runtime.runPromise(pruneDatabase(gw.userId));
      expect(
        (
          await query<{ purged: boolean }>("SELECT purged_at IS NOT NULL AS purged FROM threads WHERE id=$1::uuid", [
            target.id,
          ])
        )[0]?.purged,
      ).toBe(true);
    } finally {
      gw.worker.handlers.delete("unloadThread");
      acknowledge?.();
    }
  });

  test("a cleanup failure retries durably; rapid unarchive waits for ACK before starting new work", async () => {
    const target = await thread("Cleanup retry");
    let attempts = 0;
    let acknowledge: (() => void) | undefined;
    gw.worker.handlers.set("unloadThread", (_value, reply) => {
      attempts++;

      if (attempts === 1) reply(false, { errorCode: "THREAD_CLEANUP_PENDING" });
      else acknowledge = () => reply(true);
    });

    try {
      await gw.api.setThreadArchived({ threadId: target.id, archived: true });
      await gw.api.setThreadArchived({ threadId: target.id, archived: false });

      const sent = (
        await gw.api.sendMessage({ threadId: target.id, text: "after cleanup", clientRequestId: Bun.randomUUIDv7() })
      ).turn!;

      await eventually(
        async () => attempts,
        (count) => count >= 2,
      );
      expect(await query("SELECT status FROM turns WHERE id=$1::uuid", [sent.id])).toEqual([{ status: "queued" }]);
      expect(gw.worker.inputs.has(target.id)).toBe(false);
      await query(
        "UPDATE worker_commands SET expires_at=now()-interval '2 days' WHERE thread_id=$1::uuid AND kind='unloadThread'",
        [target.id],
      );
      const pending = await gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(gw.workerId)));
      expect(
        pending.some((c) => c.command.kind.case === "unloadThread" && c.command.kind.value.threadId === target.id),
      ).toBe(true);
      acknowledge!();
      await eventually(
        () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [sent.id]),
        (rows) => rows[0]?.status === "completed",
      );
    } finally {
      gw.worker.handlers.delete("unloadThread");
      acknowledge?.();
    }
  });
});
