import { expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Journal } from "@canopy/worker/journal";
import { ManagedRuntime } from "effect";
import { eventually } from "./support/gateway.ts";
import { startInstanceFixture } from "./support/instance-fixture.ts";

test.skipIf(!dockerAvailable)(
  "Claude background completion after archive is journaled without a continuation, survives reconnect, and leaves other turns running",
  async () => {
    const f = await startInstanceFixture();

    try {
      await f.save(Provider.CLAUDE, "archive-claude");
      await f.save(Provider.CODEX, "archive-codex");
      const target = await f.thread(Provider.CLAUDE);
      const healthy = await f.thread(Provider.CODEX);
      const first = await f.send(target.id, "BACKGROUND_ARCHIVE_TEST");
      expect((await f.finished(target.id, first.id)).status).toBe("completed");
      expect((await f.gw.api.getThread({ threadId: target.id })).thread?.backgroundTasks).toBe(1);
      const active = await f.send(healthy.id, "HOLD:archive-healthy");
      expect(
        await eventually(async () => f.host.runningTurns().some((turn) => turn.turnId === active.id), Boolean),
      ).toBe(true);
      await f.gw.api.setThreadArchived({ threadId: target.id, archived: true });
      expect(await eventually(async () => f.host.threadClosed(target.id), Boolean)).toBe(true);
      // Keep the harnesses alive, but finish the background task while its gateway link is down.
      await f.disconnect();
      await f.release("background-archive");
      await eventually(
        async () => f.host.runningTurns().filter((turn) => turn.threadId === target.id).length,
        (count) => count === 0,
      );
      // The completion is on disk before reconnect; use the task/notice journal rather than a timer alone.
      const journal = ManagedRuntime.make(Journal.layer(join(f.dir, "journal.db")));

      try {
        await eventually(
          () => journal.runPromise(Journal.use((j) => j.pending(new Map()))),
          (events) =>
            events.some(
              (event) =>
                event.threadId === target.id &&
                event.body.case === "notice" &&
                event.body.value.code === "continuation_suppressed",
            ),
        );
      } finally {
        await journal.dispose();
      }

      await f.reconnect();
      await eventually(
        () =>
          f.query<{ status: string }>(
            "SELECT status FROM thread_items WHERE thread_id=$1::uuid AND item_id='bg:app-server'",
            [target.id],
          ),
        (rows) => rows[0]?.status === "completed",
      );
      await Bun.sleep(1_200);
      expect(
        await f.query("SELECT 1 FROM turns WHERE thread_id=$1::uuid AND id<>$2::uuid", [target.id, first.id]),
      ).toHaveLength(0);
      expect(await f.query("SELECT 1 FROM worker_event_quarantine WHERE thread_id=$1::uuid", [target.id])).toHaveLength(
        0,
      );
      expect(
        await f.query("SELECT 1 FROM background_task_notes WHERE thread_id=$1::uuid AND status='cancelled'", [
          target.id,
        ]),
      ).toHaveLength(1);
      expect(f.gw.core.online.has(f.workerId)).toBe(true);
      expect(f.host.runningTurns().some((turn) => turn.turnId === active.id)).toBe(true);
      expect(f.logs.some((line) => line.includes("gateway draining"))).toBe(false);
      await f.gw.api.setThreadArchived({ threadId: target.id, archived: false });
      expect(
        await eventually(
          async () => f.host.threadClosed(target.id),
          (closed) => !closed,
        ),
      ).toBe(false);
      await f.gw.core.backgroundTasks.tick();
      expect(
        await f.query("SELECT 1 FROM turns WHERE thread_id=$1::uuid AND id<>$2::uuid", [target.id, first.id]),
      ).toHaveLength(0);
      await f.release("archive-healthy");
      expect((await f.finished(healthy.id, active.id)).status).toBe("completed");
    } finally {
      await f.close();
    }
  },
  90_000,
);
