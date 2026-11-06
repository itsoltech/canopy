/** Where Ctrl+End goes: the footer's message box, else its first control. */
export const footerField = (footer: HTMLElement | undefined): HTMLElement | null | undefined =>
  footer?.querySelector<HTMLElement>('[contenteditable="true"], textarea:not([disabled])') ??
  footer?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");

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
