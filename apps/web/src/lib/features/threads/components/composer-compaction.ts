import { FEED_END_THRESHOLD, type ReaderScroll } from "../../../shared/ui/virtual/scroll.ts";

/** Within this distance from the end the composer opens in step with the reader's way back. */
export const COMPACT_DISTANCE = 192;

/** Reading up this far folds the composer, in step with the scroll. */
export const COMPACT_TRAVEL = 96;

export type ComposerActivity = "typing" | "pointer" | "drop" | "paste" | "menu";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The composer's fold as scroll progress: 0 is full, 1 is compact. Reading up folds it over
 * `COMPACT_TRAVEL`; once folded it stays folded until the reader comes back within `COMPACT_DISTANCE`
 * of the end, where it opens in step with the remaining distance.
 */
export class ComposerCompaction {
  /** Fully folded: only the end zone opens it again. */
  compact = false;
  progress = 0;
  focused = false;
  needsInput = false;
  private travel = 0;
  private distance = 0;

  expand() {
    this.compact = false;
    this.progress = 0;
    this.travel = 0;
  }

  /** A thread reopened where the reader had scrolled up. */
  fold() {
    this.compact = true;
    this.progress = 1;
    this.travel = COMPACT_TRAVEL;
  }

  focus(focused: boolean) {
    this.focused = focused;

    if (focused) this.expand();
  }

  question(pendingSync: boolean) {
    this.needsInput = pendingSync;

    if (pendingSync) this.expand();
  }

  interact(_kind: ComposerActivity) {
    this.expand();
  }

  scroll({ distance, up }: ReaderScroll) {
    this.distance = distance;

    if (distance <= FEED_END_THRESHOLD) return this.expand();

    if (this.needsInput) return;
    this.travel = Math.min(COMPACT_TRAVEL, Math.max(0, this.travel + up));
    const near = this.near();
    this.progress = this.compact ? near : Math.min(near, this.travel / COMPACT_TRAVEL);

    if (this.progress >= 1) this.compact = true;
    else if (this.progress <= 0) this.expand();
  }

  /** The reader stopped between the two states: fold only outside the end zone and past half way. */
  rest() {
    if (this.progress <= 0 || this.progress >= 1) return;

    if (this.progress >= 0.5 && this.near() >= 1) this.fold();
    else this.expand();
  }

  private near() {
    return clamp((this.distance - FEED_END_THRESHOLD) / (COMPACT_DISTANCE - FEED_END_THRESHOLD));
  }
}
