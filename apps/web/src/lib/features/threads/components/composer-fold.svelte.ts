import type { FooterFold } from "../../../shared/ui/virtual/footer-reserve.ts";
import type { ReaderScroll } from "../../../shared/ui/virtual/scroll.ts";
import { ComposerCompaction, type ComposerActivity } from "./composer-compaction.ts";
import { ComposerMorph } from "./composer-morph.ts";

/** Wheel notches each end their own scroll: snap only once the reader has really stopped. */
const REST_DELAY = 240;

/**
 * A thread composer's fold: the scroll-linked compaction drives the morph, whose state the feed
 * reads to keep its end reserve. One per thread.
 */
export class ComposerFold {
  compact = $state(false);
  footer = $state<FooterFold>("open");
  readonly compaction = new ComposerCompaction();
  readonly #morph: ComposerMorph;
  #rest: ReturnType<typeof setTimeout> | undefined;

  constructor(root: () => HTMLElement | undefined) {
    this.#morph = new ComposerMorph(root, (compact, footer) => {
      this.compact = compact;
      this.footer = footer;
    });
  }

  expand(activity?: ComposerActivity) {
    if (activity) this.compaction.interact(activity);
    else this.compaction.expand();
    this.#morph.settle(false);
  }

  scroll(scroll: ReaderScroll) {
    clearTimeout(this.#rest);
    this.compaction.scroll(scroll);
    this.#morph.follow(this.compaction.progress);
  }

  /** The reader's scroll came to rest: finish the nearer state. */
  rest() {
    clearTimeout(this.#rest);
    this.#rest = setTimeout(() => {
      this.compaction.rest();
      const { progress } = this.compaction;

      if (progress <= 0 || progress >= 1) this.#morph.settle(progress >= 1);
    }, REST_DELAY);
  }

  focus(focused: boolean) {
    this.compaction.focus(focused);

    if (focused) this.#morph.settle(false);
  }

  /** A blocking question, or a reader at the end, opens the composer. */
  update(blocking: boolean, atEnd: boolean) {
    this.compaction.question(blocking);

    if (atEnd) this.compaction.expand();

    if (this.compaction.progress <= 0) this.#morph.settle(false);
  }

  /** Without motion: a thread opening as it was left. */
  set(compact: boolean) {
    this.#morph.set(compact);
  }

  dispose() {
    clearTimeout(this.#rest);
    this.#morph.dispose();
  }
}
