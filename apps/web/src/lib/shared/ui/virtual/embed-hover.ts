import type { ScrollIntent } from "./scroll.ts";

/**
 * Wheel and touch input over a cross-origin frame stays in the frame while its scroll chains to the feed, so the feed
 * would take that scroll for a layout one and undo it. The frame's host reports instead whether the pointer is over the
 * frame, with this event on the frame element (`detail`).
 */
const EMBED_HOVER_EVENT = "canopy-embed-hover";

export function reportEmbedHover(frame: Element, inside: boolean): void {
  frame.dispatchEvent(new CustomEvent(EMBED_HOVER_EVENT, { bubbles: true, detail: inside }));
}

/** A scroll under a hovered frame is the reader's. A move the feed's own document sees means the pointer left it. */
export function trackEmbedHover(scroller: HTMLElement, intent: ScrollIntent): () => void {
  const onHover = (event: Event) => (intent.embedded = event instanceof CustomEvent && event.detail === true);
  const onMove = () => (intent.embedded = false);
  scroller.addEventListener(EMBED_HOVER_EVENT, onHover);
  scroller.addEventListener("pointermove", onMove, { passive: true });

  return () => {
    scroller.removeEventListener(EMBED_HOVER_EVENT, onHover);
    scroller.removeEventListener("pointermove", onMove);
  };
}
