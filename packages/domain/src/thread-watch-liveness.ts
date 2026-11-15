import type { ui } from "@canopy/contracts";

export const THREAD_STALL_MS = 10_000;
const REPAIR_INTERVAL_MS = 30_000;
const MAX_REPAIR_INTERVAL_MS = 5 * 60_000;

/** Resumes from the applied cursor first; a view still stale after these is reloaded from a fresh window. */
const RESUMES = 2;

export interface ThreadWatchRepair {
  lagMs: number;
  attempt: number;
  /** Drop the applied cursor and load a fresh window, as a page reload would. */
  reload: boolean;
}

/** Overview evidence confirms missing data even when the transport still sends heartbeats. */
export class ThreadWatchLiveness {
  #checkpoint = "";
  #behindSince: number | undefined;
  #retryAt = 0;
  #repairs = 0;

  /**
   * `head` is the overview's committed sequence; `diverged` means the overview's pushed thread state has
   * disagreed with the view. Either one, held for THREAD_STALL_MS, asks for a repair. Repairs never stop
   * while the evidence lasts: they back off, and after RESUMES resumes they reload the view.
   */
  check(
    applied: ui.ThreadSyncCursor | undefined,
    head: ui.ThreadSyncCursor | undefined,
    now = Date.now(),
    diverged = false,
  ): ThreadWatchRepair | undefined {
    const lagging =
      !!applied &&
      !!head &&
      applied.threadId === head.threadId &&
      applied.epoch === head.epoch &&
      applied.appliedSeq < head.appliedSeq;

    if (!lagging && !diverged) {
      this.#settle();

      return;
    }

    const checkpoint = applied ? `${applied.threadId}:${applied.epoch}:${applied.appliedSeq}` : "";

    // Progress restarts a lagging cursor's clock. A diverged view advances without catching up, so it keeps it.
    if (checkpoint !== this.#checkpoint) {
      if (!diverged) this.#settle();
      this.#checkpoint = checkpoint;
    }

    this.#behindSince ??= now;

    if (now - this.#behindSince < THREAD_STALL_MS || now < this.#retryAt) return;
    const attempt = ++this.#repairs;
    this.#retryAt = now + Math.min(REPAIR_INTERVAL_MS * 2 ** (attempt - 1), MAX_REPAIR_INTERVAL_MS);

    return { lagMs: now - this.#behindSince, attempt, reload: attempt > RESUMES };
  }

  /** Inactive time does not count as a stalled watch; pausing does not replenish its repair budget. */
  pause() {
    this.#behindSince = undefined;
  }

  #settle() {
    this.#behindSince = undefined;
    this.#retryAt = 0;
    this.#repairs = 0;
  }
}

/**
 * The overview's thread status disagrees with the view's own turns: a running thread the view shows idle (a
 * missed prompt or turn), or a settled thread the view still shows running. Input and creation states are not
 * compared; the view has no exact counterpart for them.
 */
export function threadViewDiverged(overviewStatus: string | undefined, viewRunning: boolean) {
  if (overviewStatus === "running") return !viewRunning;

  return viewRunning && (overviewStatus === "idle" || overviewStatus === "interrupted" || overviewStatus === "failed");
}
