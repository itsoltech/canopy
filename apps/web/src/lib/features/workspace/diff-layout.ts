import type { ThreadDiffFile } from "./diff-api.ts";

export class DiffLayout {
  readonly starts: number[] = [];
  readonly paths = new Map<string, number>();
  readonly rows: number;

  constructor(readonly files: readonly ThreadDiffFile[]) {
    let total = 0;

    for (const file of files) {
      this.paths.set(file.path, total);
      this.starts.push(total);
      total += 1 + Math.max(1, file.lineCount);
    }

    this.rows = total;
  }

  fileAt(row: number): number {
    let low = 0;
    let high = this.starts.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if (this.starts[middle]! <= row) low = middle + 1;
      else high = middle;
    }

    return Math.max(0, low - 1);
  }

  window(first: number, count: number) {
    const rows: { index: number; file: ThreadDiffFile; offset: number }[] = [];
    let fileIndex = this.fileAt(first);

    for (let index = first; index < Math.min(this.rows, first + count); index++) {
      while (fileIndex + 1 < this.starts.length && this.starts[fileIndex + 1]! <= index) fileIndex++;
      const file = this.files[fileIndex];

      if (file) rows.push({ index, file, offset: index - this.starts[fileIndex]! - 1 });
    }

    return rows;
  }
}

export function diffFileStatus(status: string): string {
  switch (status) {
    case "A":
      return "Added";
    case "?":
      return "Untracked";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "T":
      return "Type changed";
    case "U":
      return "Unmerged";
    default:
      return "Modified";
  }
}
