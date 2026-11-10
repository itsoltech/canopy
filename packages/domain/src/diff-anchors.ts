export type DiffSide = "LEFT" | "RIGHT";

export interface DiffPoint {
  side: DiffSide;
  line: number;
}

export interface DiffAnchor {
  left: number;
  right: number;
  hunk: number;
  index: number;
}

export interface DiffRange {
  side: DiffSide;
  line: number;
  startSide: DiffSide;
  startLine: number;
}

/** Original blob line numbers, independent of wrapping, whitespace and split presentation. */
export function diffAnchors(patch: string): DiffAnchor[] {
  let left = 0,
    right = 0,
    hunk = 0;

  return patch
    .replace(/\n$/, "")
    .split("\n")
    .map((text, index) => {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);

      if (header) {
        left = Number(header[1]);
        right = Number(header[2]);
        hunk++;
      }

      const anchor = { left: 0, right: 0, hunk, index };

      if (!hunk || header) return anchor;

      if (text.startsWith("-")) anchor.left = left++;
      else if (text.startsWith("+")) anchor.right = right++;
      else if (text.startsWith(" ")) {
        anchor.left = left++;
        anchor.right = right++;
      }

      return anchor;
    });
}

export function diffRange(anchors: readonly DiffAnchor[], first: DiffPoint, last: DiffPoint): DiffRange | undefined {
  const find = (p: DiffPoint) => anchors.find((a) => (p.side === "LEFT" ? a.left : a.right) === p.line);

  const a = find(first),
    b = find(last);

  if (!a || !b || a.hunk !== b.hunk || first.line < 1 || last.line < 1) return;
  const [start, end] = a.index <= b.index ? [first, last] : [last, first];

  return { startSide: start.side, startLine: start.line, side: end.side, line: end.line };
}

export function selectedLine(range: DiffRange | undefined, side: DiffSide, line: number) {
  if (!range) return false;

  if (range.startSide !== range.side)
    return (side === range.startSide && line === range.startLine) || (side === range.side && line === range.line);

  return range.side === side && line >= range.startLine && line <= range.line;
}
