import type { Attachment } from "svelte/attachments";
import type { SizeIndex } from "./size-index.ts";
import type { FeedViewport } from "./viewport.ts";

/** Observe content independently of the scroller; publish its usable viewport height with each batch. */
export function feedObserver(
  index: SizeIndex,
  read: () => {
    positions: ReadonlyMap<string, number>;
    sized: readonly { group: string }[];
    scroller: HTMLElement | undefined;
  },
  publish: (viewport: number | undefined) => void,
): ResizeObserver | undefined {
  if (typeof ResizeObserver === "undefined") return;

  return new ResizeObserver((entries) => {
    const { positions, sized, scroller } = read();
    let viewport: number | undefined;

    for (const entry of entries) {
      const target = entry.target;

      if (!(target instanceof HTMLElement)) continue;

      if (target === scroller) viewport = target.clientHeight;
      else if (target.dataset.key) {
        const at = positions.get(target.dataset.key);
        const meta = at === undefined ? undefined : sized[at];

        if (meta)
          index.measure(target.dataset.key, meta.group, entry.borderBoxSize[0]?.blockSize ?? target.offsetHeight);
      }
    }

    publish(viewport);
  });
}

/** Keeps a mounted row's element by its `data-key` and measures it while it is mounted. */
export const rowAttachment =
  (elements: Map<string, HTMLElement>, observer: ResizeObserver | undefined): Attachment<HTMLElement> =>
  (element) => {
    const rowKey = element.dataset.key ?? "";
    elements.set(rowKey, element);
    observer?.observe(element);

    return () => {
      observer?.unobserve(element);

      if (elements.get(rowKey) === element) elements.delete(rowKey);
    };
  };

/** Publishes the rows between `top` and `top + height` on the next animation frame; returns its cancel. */
export function publishViewport(
  index: SizeIndex,
  top: number,
  height: number,
  callback: ((viewport: FeedViewport) => void) | undefined,
): (() => void) | undefined {
  if (!callback || height <= 0) return undefined;

  const frame = requestAnimationFrame(() => {
    const [start, end] = index.range(top, top + height);
    callback({ start, end, height });
  });

  return () => cancelAnimationFrame(frame);
}

/** Mount the scroller and list together; seed the viewport before the observer's first frame. */
export function observeFeed(
  observer: ResizeObserver | undefined,
  scroller: HTMLElement | undefined,
  list: HTMLElement | undefined,
  footer: HTMLElement | undefined,
  seed: (scroller: HTMLElement) => void,
) {
  if (!observer || !scroller || !list || !footer) return;
  seed(scroller);

  for (const element of [scroller, list]) observer.observe(element);

  return () => {
    for (const element of [scroller, list]) observer.unobserve(element);
  };
}

/** Batch observer state into one frame; synchronous settling still keeps the current rows anchored. */
export class FeedMeasurements {
  viewport = 0;
  #frame = 0;
  readonly observer: ResizeObserver | undefined;

  constructor(
    index: SizeIndex,
    read: () => {
      positions: ReadonlyMap<string, number>;
      sized: readonly { group: string }[];
      scroller: HTMLElement | undefined;
      list: HTMLElement | undefined;
    },
    settle: () => void,
    publish: (size: { viewport: number; gutter: number; listTop: number }) => void,
  ) {
    this.observer = feedObserver(index, read, (height) => {
      this.viewport = height ?? this.viewport;
      settle();
      this.#frame ||= requestAnimationFrame(() => {
        this.#frame = 0;
        const { scroller, list } = read();
        publish({
          viewport: this.viewport,
          gutter: scroller ? scroller.offsetWidth - scroller.clientWidth : 0,
          listTop:
            scroller && list
              ? list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
              : 0,
        });
      });
    });
  }

  dispose() {
    this.observer?.disconnect();
    cancelAnimationFrame(this.#frame);
  }
}
