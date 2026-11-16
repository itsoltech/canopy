import { expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Journal } from "@canopy/worker/journal";
import { ManagedRuntime } from "effect";
import { eventually } from "./support/gateway.ts";
import { startInstanceFixture } from "./support/instance-fixture.ts";

for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
  test.skipIf(!dockerAvailable)(
    `${Provider[provider]} archive stops background work offline, replays cleanup after reconnect, and preserves other threads`,
    async () => {
      const f = await startInstanceFixture();

      try {
        await f.save(provider, "archive-target");
        const target = await f.thread(provider);
        const healthy = await f.thread(provider);
        const first = await f.send(target.id, provider === Provider.CLAUDE ? "BACKGROUND_ARCHIVE_TEST" : "BACKGROUND");
        expect((await f.finished(target.id, first.id)).status).toBe("completed");
        await eventually(
          () => f.gw.api.getThread({ threadId: target.id }),
          (r) => r.thread?.backgroundTasks === 1,
        );
        const active = await f.send(healthy.id, "HOLD:archive-healthy");
        await eventually(async () => f.host.runningTurns().some((turn) => turn.turnId === active.id), Boolean);
        // The worker misses the live lifecycle delta; reconnect must apply the durable cleanup.
        await f.disconnect();
        await f.gw.api.setThreadArchived({ threadId: target.id, archived: true });
        expect(
          await f.query(
            "SELECT id FROM worker_commands WHERE thread_id=$1::uuid AND kind='unloadThread' AND status='pending'",
            [target.id],
          ),
        ).toHaveLength(1);
        await f.reconnect();
        await eventually(async () => f.host.threadClosed(target.id), Boolean);
        await eventually(
          () =>
            f.query<{ status: string }>(
              "SELECT status FROM thread_items WHERE thread_id=$1::uuid AND type='background_task'",
              [target.id],
            ),
          (rows) => rows[0]?.status === "interrupted",
        );
        await eventually(
          () =>
            f.query<{ status: string }>(
              "SELECT status FROM worker_commands WHERE thread_id=$1::uuid AND kind='unloadThread'",
              [target.id],
            ),
          (rows) => rows[0]?.status === "completed",
        );
        const journal = ManagedRuntime.make(Journal.layer(join(f.dir, "journal.db")));

        try {
          const tasks = await journal.runPromise(Journal.use((j) => j.openBackgroundTasks()));
          expect(tasks.some((task) => task.threadId === target.id)).toBe(false);
        } finally {
          await journal.dispose();
        }

        expect(
          await f.query("SELECT 1 FROM turns WHERE thread_id=$1::uuid AND id<>$2::uuid", [target.id, first.id]),
        ).toHaveLength(0);
        expect(
          await f.query("SELECT 1 FROM worker_event_quarantine WHERE thread_id=$1::uuid", [target.id]),
        ).toHaveLength(0);
        expect(
          await f.query("SELECT 1 FROM background_task_notes WHERE thread_id=$1::uuid AND status='cancelled'", [
            target.id,
          ]),
        ).toHaveLength(1);
        expect(f.host.runningTurns().some((turn) => turn.turnId === active.id)).toBe(true);
        expect(f.gw.core.online.has(f.workerId)).toBe(true);
        await f.gw.api.setThreadArchived({ threadId: target.id, archived: false });
        await f.gw.core.backgroundTasks.tick();
        expect(
          await f.query("SELECT 1 FROM turns WHERE thread_id=$1::uuid AND id<>$2::uuid", [target.id, first.id]),
        ).toHaveLength(0);
        const resumed = await f.send(target.id, "Continue after archive");
        const result = await f.finished(target.id, resumed.id);

        expect(result.status).toBe("completed");
        await f.release("archive-healthy");
        expect((await f.finished(healthy.id, active.id)).status).toBe("completed");
      } finally {
        await f.close();
      }
    },
    90_000,
  );
}
