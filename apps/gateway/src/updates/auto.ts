import type { ui } from "@canopy/contracts";

const AUTO_UPDATE_INTERVAL_MS = 60_000;

const target = (step: ui.UpdateStep) => `${step.kind}/${step.nodeId}/${step.workerId}/${step.version}`;

/**
 * Whether an automatic Update all should start from `planned`. A shown failure waits for the owner's Retry or Dismiss,
 * and an automatic run never tries the same targets twice: a failure it hit is not retried until a newer release
 * changes the target. Steps skipped as offline were not tried and stay eligible.
 */
export function automaticRunDue(stored: ui.UpdateRun | undefined, planned: ui.UpdateRun): boolean {
  if (stored && ["running", "failed", "blocked"].includes(stored.state)) return false;

  const tried = new Set(
    stored?.automatic ? stored.steps.filter((step) => !["queued", "skipped"].includes(step.state)).map(target) : [],
  );

  return planned.steps.some((step) => step.state === "queued" && !tried.has(target(step)));
}

export interface AutoUpdateOptions {
  /** The owner opted in and no work runs; see AutoUpdateStore.due. */
  due(): Promise<boolean>;
  /** Gateway update control accepts requests now. */
  ready(): boolean;
  /** Plans and starts Update all as an automatic run; resolves undefined when there was nothing to start. */
  begin(): Promise<ui.UpdatesSnapshot | undefined>;
}

/** Starts Update all once updates wait and the owner's computers are free. Off unless the owner opted in. */
export class AutoUpdates {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<boolean> | undefined;

  constructor(
    private readonly options: AutoUpdateOptions,
    private readonly intervalMs = AUTO_UPDATE_INTERVAL_MS,
  ) {}

  start() {
    this.timer ??= setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** True when this check started a run. */
  tick(): Promise<boolean> {
    return (this.ticking ??= this.check().finally(() => {
      this.ticking = undefined;
    }));
  }

  private async check() {
    if (!this.options.ready() || !(await this.options.due())) return false;

    return (await this.options.begin()) !== undefined;
  }
}
