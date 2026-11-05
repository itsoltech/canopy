import type { ui } from "@canopy/contracts";
import type { Hub } from "../core/hub.ts";
import type { ConfigSync } from "../config-sync/engine.ts";

/** Changes that may touch a worker record: the worker, its instances, tags, workspaces and connector access. */
const WATCHED = new Set<ui.OverviewUpdate["change"]["case"]>([
  "worker",
  "workerRemoved",
  "project",
  "agentEnvironmentChanged",
  "providerInstancesChanged",
]);

/**
 * This computer's worker records follow its own tables (docs/linked-computers.md, "Rekordy workerów i edycja
 * zdalna"): after a change the UI sees and every 30 s for changes without a live update.
 * Returns the stop function.
 */
export function followWorkerRecords(config: ConfigSync, hub: Hub, intervalMs = 30_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const run = () => {
    if (stopped) return;

    if (running) {
      again = true;

      return;
    }

    running = config
      .publishWorkers()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        running = undefined;

        if (again) {
          again = false;
          schedule();
        }
      });
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  };

  const subscription = hub.subscribeOverview();

  void (async () => {
    for await (const update of subscription.updates) if (WATCHED.has(update.change.case)) schedule();
  })();

  const interval = setInterval(schedule, intervalMs);

  return () => {
    stopped = true;
    subscription.close();
    clearInterval(interval);
    clearTimeout(timer);
  };
}
