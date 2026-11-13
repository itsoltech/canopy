import { restoreThreadAnchor, threadAnchorOffset, type ThreadScrollPosition } from "@canopy/domain/thread-scroll";
import type { FeedAnchor } from "./feed-anchor.ts";
import type { SizeIndex } from "./size-index.ts";

export const FEED_POSITION_TIMEOUT_MS = 2000;

export interface FeedScrollMemory {
  readonly initial: ThreadScrollPosition | undefined;
  save(position: ThreadScrollPosition): void;
  key?(identity: string): string;
  identity?(key: string): string;
  restored?(following: boolean): void;
  recovered?(): void;
}

/** One opening per mounted feed. Position after the target window has real row measurements. */
export class FeedScrollOpening {
  positioned = $state(false);
  readonly initial: ThreadScrollPosition | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #expired = false;

  constructor(readonly memory: FeedScrollMemory | undefined) {
    this.initial = memory?.initial;
    this.positioned = !memory;
  }

  get target() {
    const initial = this.initial;

    return initial?.mode === "anchor" ? { ...initial, key: this.memory?.key?.(initial.key) ?? initial.key } : undefined;
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
    if (!this.#expired && (!ready || viewport === 0 || visible.some((key) => !index.isMeasured(key)))) return false;
    const target = restoreThreadAnchor(this.target, [...positions.keys()]);
    let anchor: FeedAnchor | undefined;

    if (target) {
      const element = elements.get(target.key);

      if (element && (this.#expired || index.isMeasured(target.key))) {
        const offset = threadAnchorOffset(target.offset, element.getBoundingClientRect().height);
        anchor = {
          key: target.key,
          identity: this.initial?.mode === "anchor" ? this.initial.key : target.key,
          element,
          top: -offset,
        };
        setTop(
          scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + offset,
        );
      } else if (!this.#expired) return false;
      else setTop(scroller.scrollHeight);
    } else setTop(scroller.scrollHeight);
    this.positioned = true;
    clearTimeout(this.#deadline);
    this.memory?.restored?.(!anchor);

    return anchor;
  }

  save(following: boolean, anchor: FeedAnchor | undefined) {
    clearTimeout(this.#timer);

    if (!this.positioned || !this.memory) return;

    if (following) this.memory.save({ mode: "following" });
    else if (anchor) this.memory.save({ mode: "anchor", key: anchor.identity ?? anchor.key, offset: -anchor.top });
  }

  schedule(read: () => { following: boolean; anchor: FeedAnchor | undefined }) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      const { following, anchor } = read();
      this.save(following, anchor);
    }, 150);
  }

  connect(read: () => { following: boolean; anchor: FeedAnchor | undefined }, settle: () => void) {
    if (!this.positioned)
      this.#deadline = setTimeout(() => {
        if (this.positioned) return;
        this.#expired = true;
        this.memory?.recovered?.();
        settle();
        // Even an unavailable scroller must not leave its replacement hidden forever.
        this.positioned = true;
      }, FEED_POSITION_TIMEOUT_MS);

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
      clearTimeout(this.#deadline);
      clearTimeout(this.#timer);
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }
}
