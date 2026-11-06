export type DiffRow = { context: string } | { before?: string; after?: string };

/** Pair contiguous deletion/addition blocks without interpreting file headers as changes. */
export function diffRows(source: string, hideWhitespace: boolean): DiffRow[] {
  const lines = source.split("\n");
  const rows: DiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if ((!line.startsWith("-") && !line.startsWith("+")) || line.startsWith("---") || line.startsWith("+++")) {
      rows.push({ context: line });
      index++;
      continue;
    }

    const before: string[] = [];
    const after: string[] = [];

    while (lines[index]?.startsWith("-") && !lines[index]!.startsWith("---")) before.push(lines[index++]!);

    while (lines[index]?.startsWith("+") && !lines[index]!.startsWith("+++")) after.push(lines[index++]!);

    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const old = before[i];
      const next = after[i];

      if (
        hideWhitespace &&
        old !== undefined &&
        next !== undefined &&
        old.slice(1).replace(/\s/g, "") === next.slice(1).replace(/\s/g, "")
      )
        rows.push({ context: ` ${next.slice(1)}` });
      else rows.push({ before: old, after: next });
    }
  }

  return rows;
}
