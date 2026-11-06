/**
 * Elements a caller renders inside markdown text (e.g. mention badges in a sent message): each range of the source
 * is swapped for a private-use sentinel before lexing (no markdown syntax can split it), and the renderer draws the
 * caller's element where a sentinel appears. In code (spans and blocks) the original text comes back.
 */
export interface SentinelRange {
  /** UTF-16 offsets into the source; ranges do not overlap. */
  readonly start: number;
  readonly end: number;
}

const OPEN = "";
const CLOSE = "";
const SENTINEL = /(\d+)/g;

export interface WithSentinels {
  readonly text: string;
  /** Code text with each sentinel back to the source it replaced. */
  readonly restore: (code: string) => string;
}

/** The source with a sentinel for each range (numbered by its index in `ranges`). */
export function withSentinels(text: string, ranges: readonly SentinelRange[]): WithSentinels {
  const originals: string[] = [];
  let out = "";
  let at = 0;
  [...ranges]
    .map((range, index) => ({ ...range, index }))
    .sort((a, b) => a.start - b.start)
    .forEach(({ start, end, index }) => {
      if (start < at || end > text.length || end <= start) return;
      out += text.slice(at, start) + `${OPEN}${index}${CLOSE}`;
      originals[index] = text.slice(start, end);
      at = end;
    });
  out += text.slice(at);

  return { text: out, restore: (code) => code.replace(SENTINEL, (_, i: string) => originals[Number(i)] ?? "") };
}

export const hasSentinel = (text: string): boolean => text.includes(OPEN);

/** Text split at sentinels: strings and element indexes. */
export function splitSentinels(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let at = 0;

  for (const match of text.matchAll(SENTINEL)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(Number(match[1]));
    at = match.index + match[0].length;
  }

  if (at < text.length) parts.push(text.slice(at));

  return parts;
}
