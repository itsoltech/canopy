import type { ui } from "@canopy/contracts";

export const THREAD_STALL_MS = 10_000;
const REPAIR_INTERVAL_MS = 30_000;
const MAX_REPAIRS = 3;

/** Overview heads confirm missing data even when the transport still sends heartbeats. */
export class ThreadWatchLiveness {
  #checkpoint = "";
  #behindSince: number | undefined;
  #retryAt = 0;
  #repairs = 0;

  check(applied: ui.ThreadSyncCursor | undefined, head: ui.ThreadSyncCursor | undefined, now = Date.now()) {
    if (!applied || !head || applied.threadId !== head.threadId || applied.epoch !== head.epoch) {
      this.pause();

      return;
    }

    const checkpoint = `${applied.threadId}:${applied.epoch}:${applied.appliedSeq}`;

    if (checkpoint !== this.#checkpoint) {
      this.#checkpoint = checkpoint;
      this.#repairs = 0;
      this.#retryAt = 0;
      this.pause();
    }

    if (applied.appliedSeq >= head.appliedSeq) {
      this.pause();

      return;
    }

    this.#behindSince ??= now;

    if (now - this.#behindSince < THREAD_STALL_MS || now < this.#retryAt || this.#repairs >= MAX_REPAIRS) return;
    this.#retryAt = now + REPAIR_INTERVAL_MS;

    return { lagMs: now - this.#behindSince, attempt: ++this.#repairs };
  }

  /** Inactive time does not count as a stalled watch; pausing does not replenish its repair budget. */
  pause() {
    this.#behindSince = undefined;
  }
}
