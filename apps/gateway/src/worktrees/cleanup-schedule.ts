import { create } from "@bufbuild/protobuf";
import { withProcessPriority } from "@canopy/process-governor";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreLog } from "../core/core-broadcast.ts";

/** Gateway owns the schedule; offline records stay live and are reconsidered on reconnect. */
export class WorktreeCleanupSchedule {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = new Map<string, Promise<void>>();
  #stop = new AbortController();

  constructor(readonly core: GatewayCore) {}

  start(): void {
    if (this.#stop.signal.aborted) this.#stop = new AbortController();
    this.#timer ??= setInterval(() => void this.tick(), 60 * 60_000);
    void this.tick();
  }

  tick(workerId = ""): Promise<void> {
    const signal = this.#stop.signal;

    if (signal.aborted) return Promise.resolve();
    const existing = this.#running.get(workerId) ?? this.#running.get("");

    if (existing) return existing;

    const run = withProcessPriority("background", () =>
      this.core.cleanupWorktrees(create(ui.CleanupWorktreesRequestSchema, { workerId, dryRun: false }), signal),
    )
      .then(() => {})
      .catch(() => {
        if (!signal.aborted) coreLog(this.core, "worktree cleanup unavailable; will retry later");
      })
      .finally(() => this.#running.delete(workerId));

    this.#running.set(workerId, run);

    return run;
  }

  async stop(): Promise<void> {
    this.#stop.abort();

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all(this.#running.values());
  }
}
