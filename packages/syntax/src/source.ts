export interface SourceRow {
  readonly from: number;
  readonly to: number;
  readonly line: number;
  readonly continued: boolean;
}

interface IndexData {
  offsets: Uint32Array;
  lines: Uint32Array;
  continuations: Uint8Array;
  rowCount: number;
  lineCount: number;
  longest: number;
}

/** Sparse UTF-16 index. No array of strings or object per source line, even for newline-heavy files. */
export class SourceIndex {
  readonly #offsets: Uint32Array;
  readonly #lines: Uint32Array;
  readonly #continuations: Uint8Array;
  readonly rows: number;
  readonly lines: number;
  readonly longest: number;

  constructor(
    readonly text: string,
    data = synchronousIndex(text),
  ) {
    this.#offsets = data.offsets;
    this.#lines = data.lines;
    this.#continuations = data.continuations;
    this.rows = data.rowCount;
    this.lines = data.lineCount;
    this.longest = data.longest;
  }

  /** UI callers yield between bounded chunks; CPU executors may use the synchronous constructor. */
  static async create(text: string, yieldWork: () => Promise<void>): Promise<SourceIndex> {
    const scan = scanSource(text);
    let step = scan.next();

    while (!step.done) {
      await yieldWork();
      step = scan.next();
    }

    return new SourceIndex(text, step.value);
  }

  row(index: number): SourceRow {
    const target = Math.max(0, Math.min(this.rows - 1, index));
    const checkpoint = Math.floor(target / 128);
    let from = this.#offsets[checkpoint] ?? 0;
    let line = this.#lines[checkpoint] ?? 1;
    let continued = Boolean(this.#continuations[checkpoint]);
    let newline = this.text.indexOf("\n", from);
    let end = newline < 0 ? this.text.length : newline;

    for (let i = checkpoint * 128; ; i++) {
      const to = chunkEnd(this.text, from, end);

      if (i === target) return { from, to, line, continued };

      if (to === end) {
        from = to + 1;
        line++;
        continued = false;
        newline = this.text.indexOf("\n", from);
        end = newline < 0 ? this.text.length : newline;
      } else {
        from = to;
        continued = true;
      }
    }
  }

  rowForLine(line: number): number {
    let low = 0;
    let high = this.#lines.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if ((this.#lines[middle] ?? 1) < line) low = middle + 1;
      else high = middle;
    }

    let index = Math.max(0, low - 1) * 128;

    let current = this.#lines[Math.max(0, low - 1)] ?? 1;
    let offset = this.#offsets[Math.max(0, low - 1)] ?? 0;

    while (index < this.rows - 1 && current < line) {
      const newline = this.text.indexOf("\n", offset);
      const end = newline < 0 ? this.text.length : newline;
      const to = chunkEnd(this.text, offset, end);
      offset = to === end ? to + 1 : to;

      if (to === end) current++;
      index++;
    }

    return index;
  }

  line(line: number) {
    const from = this.row(this.rowForLine(line)).from;
    const newline = this.text.indexOf("\n", from);

    return { from, to: newline < 0 ? this.text.length : newline };
  }

  lineForOffset(offset: number): number {
    let low = 0;
    let high = this.#offsets.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if ((this.#offsets[middle] ?? 0) <= offset) low = middle + 1;
      else high = middle;
    }

    const checkpoint = Math.max(0, low - 1);
    let line = this.#lines[checkpoint] ?? 1;
    let from = this.#offsets[checkpoint] ?? 0;

    for (;;) {
      const newline = this.text.indexOf("\n", from);

      if (newline < 0 || newline >= offset) return line;
      line++;
      from = newline + 1;
    }
  }
}

function synchronousIndex(text: string): IndexData {
  const scan = scanSource(text);
  let step = scan.next();

  while (!step.done) step = scan.next();

  return step.value;
}

function* scanSource(text: string): Generator<void, IndexData> {
  const offsets: number[] = [];
  const lines: number[] = [];
  const continuations: number[] = [];
  let row = 0;
  let line = 1;
  let from = 0;
  let longest = 0;

  for (;;) {
    const newline = text.indexOf("\n", from);
    const to = newline < 0 ? text.length : newline;
    longest = Math.max(longest, to - from);
    let part = from;

    do {
      if (row % 128 === 0) {
        offsets.push(part);
        lines.push(line);
        continuations.push(Number(part !== from));
      }

      row++;
      part = chunkEnd(text, part, to);

      if (row % 4096 === 0) yield;
    } while (part < to);

    if (newline < 0) break;
    from = to + 1;
    line++;
  }

  return {
    offsets: new Uint32Array(offsets),
    lines: new Uint32Array(lines),
    continuations: new Uint8Array(continuations),
    rowCount: row,
    lineCount: line,
    longest,
  };
}

/** Bound each rendered text node without splitting a surrogate pair or dropping any characters. */
function chunkEnd(text: string, from: number, end: number): number {
  let to = Math.min(from + 4096, end);
  const last = text.charCodeAt(to - 1);

  if (to < end && last >= 0xd800 && last <= 0xdbff) to--;

  return to;
}
