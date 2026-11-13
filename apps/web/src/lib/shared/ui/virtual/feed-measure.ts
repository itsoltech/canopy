import type { Attachment } from "svelte/attachments";
import type { SizeIndex } from "./size-index.ts";
import type { FeedViewport } from "./viewport.ts";

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
