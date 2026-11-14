/**
 * The footer's visible top edge, as a distance from its bottom. Footer content marks the boxes that paint
 * (`data-feed-edge`: the composer surface, a drafts tab, panels above it); reserved empty space above them
 * does not count. Without a marked box, the whole footer counts. "Jump to latest" and the fade above the
 * footer anchor to this edge, so they follow the composer in every state without covering it.
 */
export function watchFooterEdge(footer: HTMLElement, onedge: (edge: number) => void): () => void {
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
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  const resize = new ResizeObserver(schedule);
  resize.observe(footer);
  // Drafts and panels can appear inside space the footer already reserves, without resizing it.
  const mutations = new MutationObserver(schedule);
  mutations.observe(footer, { childList: true, subtree: true });
  measure();

  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
  };
}
