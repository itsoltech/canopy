/** Where Ctrl+End goes: the footer's message box, else its first control. */
export const footerField = (footer: HTMLElement | undefined): HTMLElement | null | undefined =>
  footer?.querySelector<HTMLElement>('[contenteditable="true"], textarea:not([disabled])') ??
  footer?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");

/** Ctrl+Home/End focus the feed or its composer without the browser scrolling the page. */
export function focusFeedBoundary(
  event: KeyboardEvent,
  footer: HTMLElement | undefined,
  scroller: HTMLElement | undefined,
): boolean {
  if (!event.ctrlKey || (event.key !== "Home" && event.key !== "End")) return false;
  event.preventDefault();
  (event.key === "End" ? footerField(footer) : scroller)?.focus({ preventScroll: true });

  return true;
}

/** Row containing a focused control or keyboard event target. */
export function feedRowKey(target: EventTarget | null): string | undefined {
  return target instanceof Element ? target.closest<HTMLElement>("article[data-key]")?.dataset.key : undefined;
}

/** The key of the row a Page Up/Down moves from; text fields and scrollable code keep their own Page keys. */
export function pagedRow(event: KeyboardEvent): string | undefined {
  if (event.key !== "PageDown" && event.key !== "PageUp") return undefined;
  const target = event.target;

  if (!(target instanceof Element) || target.closest("pre, textarea, input, select, [contenteditable]"))
    return undefined;

  return feedRowKey(target);
}

/** Reveal a mounted, keyboard-focused row without hiding it behind the composer. */
export function focusFeedRow(element: HTMLElement | undefined, scroller: HTMLElement, footerHeight: number): void {
  if (!element) return;

  element.focus({ preventScroll: true });
  element.scrollIntoView({
    block: element.offsetHeight > scroller.clientHeight - footerHeight ? "start" : "nearest",
  });
}

/** Page keys navigate feed articles; boundaries keep their existing focus destination. */
export function navigateFeedKey(
  event: KeyboardEvent,
  footer: HTMLElement | undefined,
  scroller: HTMLElement | undefined,
  positions: ReadonlyMap<string, number>,
  focus: (at: number) => Promise<void>,
): void {
  if (event.defaultPrevented || focusFeedBoundary(event, footer, scroller)) return;
  const current = pagedRow(event);
  const at = current === undefined ? undefined : positions.get(current);

  if (at === undefined) return;
  event.preventDefault();
  void focus(at + (event.key === "PageDown" ? 1 : -1));
}

/** Keep native short scrolls, but mount the destination directly for a boundary jump. */
export function handleFeedScrollKey(
  event: KeyboardEvent,
  scroller: HTMLElement | undefined,
  list: HTMLElement | undefined,
  gesture: () => void,
  jump: (edge: "Home" | "End") => void,
): void {
  const target = event.target;

  if (
    event.defaultPrevented ||
    !(target instanceof Element) ||
    target.closest("textarea, input, select, [contenteditable]")
  )
    return;

  if (list && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    getSelection()?.selectAllChildren(list);

    return;
  }

  if (
    target === scroller &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    gesture();
    jump(event.key);

    return;
  }

  if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) gesture();
}
