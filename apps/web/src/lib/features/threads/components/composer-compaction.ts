/** Shared with the feed: returning to this distance resumes following the end. */
export const FEED_END_THRESHOLD = 8;
export const COMPACT_DISTANCE = 192;
export const COMPACT_TRAVEL = 96;

export interface ReaderScroll {
  distance: number;
  /** Positive towards older messages. Only reader-originated movement belongs here. */
  up: number;
}

export class ComposerCompaction {
  compact = false;
  focused = false;
  needsInput = false;
  private travel = 0;

  expand() {
    this.compact = false;
    this.travel = 0;
  }

  focus(focused: boolean) {
    this.focused = focused;
    if (focused) this.expand();
  }

  question(pendingSync: boolean) {
    this.needsInput = pendingSync;
    if (pendingSync) this.expand();
  }

  interact(_kind: "typing" | "drop" | "paste" | "menu") {
    this.expand();
  }

  scroll({ distance, up }: ReaderScroll) {
    if (distance <= FEED_END_THRESHOLD) return this.expand();
    if (this.focused || this.needsInput) return;
    this.travel = Math.max(0, this.travel + up);
    if (distance >= COMPACT_DISTANCE && this.travel >= COMPACT_TRAVEL) this.compact = true;
  }
}
