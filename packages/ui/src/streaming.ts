/** Show complete lines while streaming and flush the remaining text when the stream ends. */
export function streamingText(text: string, streaming: boolean): string {
  if (!streaming) return text;
  let end = text.lastIndexOf("\n") + 1;

  if (end > 0 && heldTableHeader(text, end)) end = text.lastIndexOf("\n", end - 2) + 1;

  return text.slice(0, end);
}

/** The last complete line (ending at `end`) starts a table and the delimiter row is not there yet. */
function heldTableHeader(text: string, end: number): boolean {
  const start = text.lastIndexOf("\n", end - 2) + 1;

  if (!/^\s{0,3}\|/.test(text.slice(start, end))) return false;
  const previous = text.slice(text.lastIndexOf("\n", start - 2) + 1, start);

  return !/^\s{0,3}\|/.test(previous);
}
