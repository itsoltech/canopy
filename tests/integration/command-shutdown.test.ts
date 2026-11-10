import { describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type CommandHandler } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("gateway command delivery during shutdown", () => {
  test("an interrupted command acknowledgement stays in the outbox and replays after restart", async () => {
    let gw = await startTestGateway();

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    const locker = ManagedRuntime.make(gw.pg.layer);
    const release = Promise.withResolvers<void>();
    let holding: Promise<void> | undefined;
    let closed = false;
    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);

    try {
      const project = (await gw.api.createProject({ name: "Shutdown delivery" })).project!;

      const workspace = (
        await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo/shutdown" })
      ).workspace!;

      const received = Promise.withResolvers<Parameters<CommandHandler>[1]>();
      gw.worker.handlers.set("createThread", (_command, reply) => received.resolve(reply));

      const thread = (
        await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
      ).thread!;

      const reply = await received.promise;
      const locked = Promise.withResolvers<void>();

      holding = locker.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM worker_commands WHERE thread_id = ${thread.id}::uuid FOR UPDATE`;
              locked.resolve();
              yield* Effect.promise(() => release.promise);
            }),
          );
        }),
      );
      await locked.promise;
      reply(true);

      const blocked = await eventually(
        () =>
          locker.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql<{ count: number }>`SELECT count(*)::int AS count
              FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%UPDATE worker_commands SET status%'`,
            ),
          ),
        (rows) => rows[0]?.count === 1,
      );

      expect(blocked[0]?.count).toBe(1);

      // The worker has ACKed, but the gateway cannot persist it before its runtime is interrupted.
      await gw.close(true);
      closed = true;
      await Bun.sleep(0);
      expect(unhandled).toBe(0);
      release.resolve();
      await holding;

      const pending = await locker.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql<{ status: string }>`SELECT status FROM worker_commands WHERE thread_id = ${thread.id}::uuid`,
        ),
      );

      expect(pending.map((command) => command.status)).toEqual(["pending"]);
      await locker.dispose();

      gw = await startTestGateway({ storage });
      closed = false;

      const restored = await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (result) => result.thread?.status === "idle",
      );

      expect(restored.thread?.status).toBe("idle");
      expect(gw.worker.created.filter((created) => created.threadId === thread.id)).toHaveLength(1);
      expect(unhandled).toBe(0);
    } finally {
      release.resolve();
      await holding;
      await locker.dispose();

      if (!closed) await gw.close();
      else await gw.pg.stop();
      process.off("unhandledRejection", onUnhandled);
    }
  }, 30_000);
});
