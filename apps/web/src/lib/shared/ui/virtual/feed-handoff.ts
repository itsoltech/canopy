import type { ThreadScrollPosition } from "@canopy/domain/thread-scroll";
import { settleAnchor, type FeedAnchor } from "./feed-anchor.ts";
import type { FeedScrollMemory } from "./feed-scroll-memory.svelte.ts";

/** A preparation view and a measured feed exchange a row identity and offset, never an animation. */
export class FeedHandoff {
  constructor(
    readonly read: () => {
      scroller: HTMLElement | undefined;
      elements: ReadonlyMap<string, HTMLElement>;
      memory: FeedScrollMemory | undefined;
    },
    readonly anchor: (anchor: FeedAnchor | undefined) => void,
    readonly save: () => void,
    readonly setTop: (top: number) => void,
  ) {}

  restore(position: ThreadScrollPosition): boolean {
    const { scroller, elements, memory } = this.read();

    if (!scroller) return false;

    if (position.mode === "following") {
      this.anchor(undefined);
      this.setTop(scroller.scrollHeight);

      return true;
    }

    const key = memory?.key?.(position.key) ?? position.key;
    const element = elements.get(key);

    if (!element) return false;
    const anchor = { key, element, top: -position.offset };
    this.anchor(anchor);

    return settleAnchor(anchor, elements, scroller, this.setTop);
  }
}
