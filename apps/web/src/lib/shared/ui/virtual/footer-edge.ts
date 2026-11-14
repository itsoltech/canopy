/**
 * The footer's visible top edge, as a distance from its bottom. Footer content marks the boxes that paint
 * (`data-feed-edge`: the composer surface, a drafts tab, panels above it); reserved empty space above them
 * does not count. Without a marked box, the whole footer counts. "Jump to latest" and the fade above the
 * footer anchor to this edge, so they follow the composer in every state without covering it.
 *
 * A resize is measured in the ResizeObserver callback itself: layout is clean there, so a footer that
 * folds frame by frame moves its edge in the same frame without forcing another layout. `onheight` gets
 * the footer's own height from the same observer (`first` for the synchronous initial measurement).
 */
export function watchFooterEdge(
  footer: HTMLElement,
  onedge: (edge: number) => void,
  onheight?: (height: number, first: boolean) => void,
): () => void {
  let frame = 0;
  let last = -1;

  const measure = () => {
    frame = 0;
    const box = footer.getBoundingClientRect();
    let top = box.bottom;

    for (const element of footer.querySelectorAll<HTMLElement>("[data-feed-edge]")) {
      const rect = element.getBoundingClientRect();

      if (rect.height > 0) top = Math.min(top, rect.top);
    }

    const edge = Math.round(top === box.bottom ? box.height : box.bottom - top);

    if (edge !== last) onedge((last = edge));

    return box.height;
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  const resize = new ResizeObserver(([entry]) => {
    cancelAnimationFrame(frame);
    const height = measure();
    onheight?.(entry?.borderBoxSize[0]?.blockSize ?? height, false);
  });

  // Drafts and panels can appear inside space the footer already reserves, without resizing it.
  const mutations = new MutationObserver(schedule);
  onheight?.(measure(), true);
  resize.observe(footer);
  mutations.observe(footer, { childList: true, subtree: true });

  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
  };
}
