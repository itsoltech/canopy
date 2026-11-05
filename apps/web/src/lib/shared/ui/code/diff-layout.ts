import type { DiffLine } from "./diff.ts";

export interface DiffRow {
  left?: DiffLine;
  right?: DiffLine;
  full?: DiffLine;
}

/** Compare complete replacement runs, retaining every change that includes non-whitespace text. */
export function visibleDiffLines(lines: readonly DiffLine[], hideWhitespace: boolean): readonly DiffLine[] {
  if (!hideWhitespace) return lines;
  const result: DiffLine[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;

    if (line.kind !== "add" && line.kind !== "del") {
      result.push(line);
      index++;
      continue;
    }

    const run: DiffLine[] = [];

    while (index < lines.length && (lines[index]!.kind === "add" || lines[index]!.kind === "del"))
      run.push(lines[index++]!);
    const old = run.filter((l) => l.kind === "del");
    const next = run.filter((l) => l.kind === "add");

    const normalize = (side: DiffLine[]) =>
      side
        .map((l) => l.code)
        .join("\n")
        .replace(/\s/g, "");

    if (old.length && next.length && normalize(old) === normalize(next)) continue;
    result.push(...run);
  }

  return result;
}

export function splitDiffLines(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;

    if (line.kind === "file" || line.kind === "hunk") {
      rows.push({ full: line });
      index++;
      continue;
    }

    if (line.kind === "ctx") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }

    const old: DiffLine[] = [];
    const next: DiffLine[] = [];

    while (index < lines.length && (lines[index]!.kind === "add" || lines[index]!.kind === "del")) {
      const change = lines[index++]!;
      (change.kind === "del" ? old : next).push(change);
    }

    for (let i = 0; i < Math.max(old.length, next.length); i++) rows.push({ left: old[i], right: next[i] });
  }

  return rows;
}
