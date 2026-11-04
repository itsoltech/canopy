/**
 * Rules of line-by-line streaming (`LineReveal`): what part of a streaming text is on screen. The
 * whole text stays in state; only its presentation waits for line ends, so markdown and the DOM change
 * once per line instead of once per token.
 */

/** A partial trailing line shows after this long without a revealed line (ms). */
export const LINE_IDLE_MS = 300;

/**
 * Length of the text shown while it streams: everything up to its last line break, and never less than
 * what was already shown (`revealed`, e.g. a partial line flushed after idle). A table's header row
 * waits for the line after it, so it does not show as a paragraph first.
 */
export function lineCut(text: string, revealed: number): number {
  let end = text.lastIndexOf("\n") + 1;

  if (end > revealed && heldTableHeader(text, end)) end = text.lastIndexOf("\n", end - 2) + 1;

  return Math.min(text.length, Math.max(revealed, end));
}

/**
 * Length shown after an idle pause: the partial line up to its last whole word (the rest of a word that
 * is still arriving waits), all of it when there is no word break or nothing would be added. A partial
 * fence or table row is not flushed (it would show as raw markup); the next line or the end brings it.
 */
export function idleCut(text: string, shown: number): number {
  if (shown >= text.length) return text.length;
  const lineStart = text.lastIndexOf("\n", shown - 1) + 1;

  if (/^\s{0,3}(`{3,}|~{3,}|\|)/.test(text.slice(lineStart))) return shown;
  const space = Math.max(text.lastIndexOf(" ", text.length - 1), text.lastIndexOf("\t", text.length - 1));

  return space + 1 > shown ? space + 1 : text.length;
}

/** The last complete line (ending at `end`) starts a table and the delimiter row is not there yet. */
function heldTableHeader(text: string, end: number): boolean {
  const start = text.lastIndexOf("\n", end - 2) + 1;

  if (!/^\s{0,3}\|/.test(text.slice(start, end))) return false;
  const previous = text.slice(text.lastIndexOf("\n", start - 2) + 1, start);

  return !/^\s{0,3}\|/.test(previous);
}
