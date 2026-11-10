const isSelectAll = (event: KeyboardEvent) =>
  event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;

/**
 * Mod+A in a reading dialog (onkeydown of the dialog): inside a focused region it selects only the region's
 * `[data-select-content]` (the text, never the `select-none` line numbers); elsewhere in the dialog it selects
 * nothing rather than the whole page behind it. Fields and editors that handle it themselves keep their own.
 */
export function confineSelectAll(event: KeyboardEvent): void {
  if (event.defaultPrevented || !isSelectAll(event)) return;
  const target = event.target;

  if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea"))) return;
  event.preventDefault();
  const region = target instanceof Element ? target.closest("[role=region]") : null;
  const content = region?.matches("[data-select-content]") ? region : region?.querySelector("[data-select-content]");

  if (!content) return;
  const range = document.createRange();
  range.selectNodeContents(content);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** A closed dialog leaves no selection behind in the page. */
export const clearSelection = (): void => getSelection()?.removeAllRanges();
