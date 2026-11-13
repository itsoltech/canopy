import { restoreThreadAnchor, threadAnchorOffset, type ThreadScrollPosition } from "@canopy/domain/thread-scroll";
import type { FeedAnchor } from "./feed-anchor.ts";
import type { SizeIndex } from "./size-index.ts";

export interface FeedScrollMemory {
  readonly initial: ThreadScrollPosition | undefined;
  save(position: ThreadScrollPosition): void;
  restored?(following: boolean): void;
}

/** One opening per mounted feed. Position after the target window has real row measurements. */
export class FeedScrollOpening {
  positioned = $state(false);
  readonly initial: ThreadScrollPosition | undefined;
  target: Extract<ThreadScrollPosition, { mode: "anchor" }> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly memory: FeedScrollMemory | undefined) {
    this.initial = memory?.initial;
    this.target = this.initial?.mode === "anchor" ? this.initial : undefined;
    this.positioned = !memory;
  }

  place(
    scroller: HTMLElement,
    elements: ReadonlyMap<string, HTMLElement>,
    index: SizeIndex,
    positions: ReadonlyMap<string, number>,
    visible: readonly string[],
    ready: boolean,
    viewport: number,
    setTop: (top: number) => void,
  ): FeedAnchor | false | undefined {
    if (!ready || viewport === 0 || visible.some((key) => !index.isMeasured(key))) return false;
    const target = restoreThreadAnchor(this.target, [...positions.keys()]);
    let anchor: FeedAnchor | undefined;

    if (target) {
      const element = elements.get(target.key);

      if (!element || !index.isMeasured(target.key)) return false;
      const offset = threadAnchorOffset(target.offset, element.getBoundingClientRect().height);
      anchor = { key: target.key, element, top: -offset };
      setTop(scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + offset);
    } else setTop(scroller.scrollHeight);
    this.target = undefined;
    this.positioned = true;
    this.memory?.restored?.(!anchor);

    return anchor;
  }

  save(following: boolean, anchor: FeedAnchor | undefined) {
    clearTimeout(this.#timer);

    if (!this.positioned || !this.memory) return;

    if (following) this.memory.save({ mode: "following" });
    else if (anchor) this.memory.save({ mode: "anchor", key: anchor.key, offset: -anchor.top });
  }

  schedule(read: () => { following: boolean; anchor: FeedAnchor | undefined }) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      const { following, anchor } = read();
      this.save(following, anchor);
    }, 150);
  }

  connect(read: () => { following: boolean; anchor: FeedAnchor | undefined }) {
    const flush = () => {
      const { following, anchor } = read();
      this.save(following, anchor);
    };

    const hidden = () => {
      if (document.hidden) flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);

    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }
}
