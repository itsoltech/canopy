/** Above any of these, a file opens as plain text until the reader asks for colours (docs/workspace.md §5). */
export const PLAIN_TEXT_LIMITS = { bytes: 200 * 1024, lines: 10_000, longest: 2000 } as const;

export interface SourceShape {
  /** Lines as the reader numbers them: a trailing newline starts one more, empty line. */
  lines: number;
  /** UTF-16 length of the longest line. */
  longest: number;
  /** UTF-8 size. */
  bytes: number;
}

/**
 * The file's final layout facts in one pass, before any index or highlighter exists: the reader sizes its
 * gutter and decides on plain text from the first paint, so neither changes when indexing finishes.
 */
export function sourceShape(text: string): SourceShape {
  let lines = 1;
  let longest = 0;
  let from = 0;

  for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n", from)) {
    longest = Math.max(longest, newline - from);
    from = newline + 1;
    lines++;
  }

  return { lines, longest: Math.max(longest, text.length - from), bytes: utf8Length(text) };
}

export function plainByDefault(shape: SourceShape): boolean {
  return (
    shape.bytes > PLAIN_TEXT_LIMITS.bytes ||
    shape.lines > PLAIN_TEXT_LIMITS.lines ||
    shape.longest > PLAIN_TEXT_LIMITS.longest
  );
}

/**
 * Digit columns for line numbers. Files up to 999 lines share one width, so switching between them never moves
 * the text; a longer file gets its width from the known line count, once.
 */
export function gutterDigits(lines: number): number {
  return Math.max(3, String(Math.max(1, Math.floor(lines))).length);
}

function utf8Length(text: string): number {
  let bytes = text.length;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 2;
      index++;
    } else if (code >= 0x800) bytes += 2;
    else if (code >= 0x80) bytes += 1;
  }

  return bytes;
}
