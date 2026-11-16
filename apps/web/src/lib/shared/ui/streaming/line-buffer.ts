/**
 * Rules of line-by-line streaming (`LineReveal`): what part of a streaming text is on screen. The
 * whole text stays in state; only its presentation waits for line ends, so markdown and the DOM change
 * once per line instead of once per token.
 */

/**
 * Length of the text shown while it streams: everything up to its last line break. A table's header row
 * waits for the line after it, so it does not show as a paragraph first. The trailing partial line is
 * deliberately held until the item stops streaming, which keeps the UI from moving on every token.
 */
export function lineCut(text: string): number {
  let end = text.lastIndexOf("\n") + 1;

  if (end > 0 && heldTableHeader(text, end)) end = text.lastIndexOf("\n", end - 2) + 1;

  return Math.min(text.length, end);
}

/** The last complete line (ending at `end`) starts a table and the delimiter row is not there yet. */
function heldTableHeader(text: string, end: number): boolean {
  const start = text.lastIndexOf("\n", end - 2) + 1;

  if (!/^\s{0,3}\|/.test(text.slice(start, end))) return false;
  const previous = text.slice(text.lastIndexOf("\n", start - 2) + 1, start);

  return !/^\s{0,3}\|/.test(previous);
}
