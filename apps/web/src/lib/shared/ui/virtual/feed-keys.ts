/** Where Ctrl+End goes: the footer's message box, else its first control. */
export const footerField = (footer: HTMLElement | undefined): HTMLElement | null | undefined =>
  footer?.querySelector<HTMLElement>('[contenteditable="true"], textarea:not([disabled])') ??
  footer?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");

/** The key of the row a Page Up/Down moves from; text fields and scrollable code keep their own Page keys. */
export function pagedRow(event: KeyboardEvent): string | undefined {
  if (event.key !== "PageDown" && event.key !== "PageUp") return undefined;
  const target = event.target;

  if (!(target instanceof Element) || target.closest("pre, textarea, input, select, [contenteditable]"))
    return undefined;

  return target.closest<HTMLElement>("article[data-key]")?.dataset.key;
}
