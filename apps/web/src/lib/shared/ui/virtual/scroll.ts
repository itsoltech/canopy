/** Shared by readers and footer controls; the feed resumes following within this distance. */
export const FEED_END_THRESHOLD = 8;

export interface ReaderScroll {
  distance: number;
  /** Positive towards older messages. Only reader-originated movement belongs here. */
  up: number;
}

/** Layout clamping can look like an upward scroll after a measured row grows again. Only gestures release following. */
export function followingAfterScroll(
  following: boolean,
  origin: "reader" | "programmatic" | "unattributed",
  distance: number,
  up: number,
  targeting: boolean,
): boolean {
  if (origin !== "reader") return following;

  if (!targeting && distance <= FEED_END_THRESHOLD) return true;

  return up > 0.5 ? false : following;
}

/** A short gesture lease includes touch/trackpad inertia, but never our own scroll writes.
 * Consumed scroll events can arrive through ResizeObserver before the native scroll listener. */
export class ScrollIntent {
  private until = 0;
  private expected = Number.NaN;
  /** The pointer is over an embedded frame (embed-hover.ts): a scroll there is the reader's own. */
  embedded = false;

  gesture(now = performance.now()) {
    this.until = now + 250;
  }
  reset() {
    this.until = 0;
  }
  programmatic(top: number) {
    this.expected = top;
  }

  origin(top: number, smoothUntil: number, now = performance.now()): "reader" | "programmatic" | "unattributed" {
    const ours = Math.abs(top - this.expected) < 1;
    this.expected = Number.NaN;

    if (ours || now < smoothUntil) return "programmatic";

    if (now >= this.until && !this.embedded) return "unattributed";
    this.gesture(now);

    return "reader";
  }
}
