/** A row of a virtual list: a stable key and a group whose measured sizes estimate the unmeasured rows. */
export interface SizedRow {
  readonly key: string;
  readonly group: string;
}

/**
 * Heights of a virtual list's rows: measured ones by key (they survive reordering, prepending and
 * re-renders), the others estimated by the average of their group (or `fallback` until one of the group
 * is measured). Offsets are prefix sums, rebuilt lazily after a change: O(n) per change, O(log n) per lookup.
 */
export class SizeIndex {
  readonly #fallback: (group: string) => number;
  #rows: readonly SizedRow[] = [];
  readonly #measured = new Map<string, { size: number; group: string }>();
  readonly #groups = new Map<string, { sum: number; count: number }>();
  #offsets = new Float64Array(1);
  #dirty = true;

  constructor(fallback: (group: string) => number) {
    this.#fallback = fallback;
  }

  get count(): number {
    return this.#rows.length;
  }

  setRows(rows: readonly SizedRow[]): void {
    if (rows === this.#rows) return;
    this.#rows = rows;
    this.#dirty = true;
  }

  keyAt(index: number): string | undefined {
    return this.#rows[index]?.key;
  }

  /** Records a measured height; true when it changed. */
  measure(key: string, group: string, size: number): boolean {
    const previous = this.#measured.get(key);

    if (previous && Math.abs(previous.size - size) < 0.5) return false;

    if (previous) this.#tally(previous.group, -previous.size, -1);
    this.#measured.set(key, { size, group });
    this.#tally(group, size, 1);
    this.#dirty = true;

    return true;
  }

  isMeasured(key: string): boolean {
    return this.#measured.has(key);
  }

  estimate(group: string): number {
    const tally = this.#groups.get(group);

    return tally && tally.count > 0 ? tally.sum / tally.count : this.#fallback(group);
  }

  size(index: number): number {
    const row = this.#rows[index];

    if (!row) return 0;

    return this.#measured.get(row.key)?.size ?? this.estimate(row.group);
  }

  /** Top of row `index` (index = count gives the total height). */
  offset(index: number): number {
    const offsets = this.#build();

    return offsets[Math.max(0, Math.min(index, this.#rows.length))] ?? 0;
  }

  get total(): number {
    return this.offset(this.#rows.length);
  }

  /** The row that covers `offset` (clamped to the rows). */
  indexAt(offset: number): number {
    const offsets = this.#build();
    const count = this.#rows.length;

    if (count === 0) return 0;
    let low = 0;
    let high = count - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;

      if ((offsets[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }

    return low;
  }

  /** Rows that intersect [top, bottom): `[start, end)`. */
  range(top: number, bottom: number): [number, number] {
    const count = this.#rows.length;

    if (count === 0) return [0, 0];
    const start = this.indexAt(top);
    const end = Math.min(count, this.indexAt(Math.max(top, bottom - 0.5)) + 1);

    return [start, Math.max(start, end)];
  }

  /** The last rows that fill `height`: `[start, count)`. */
  tail(height: number): [number, number] {
    const count = this.#rows.length;

    return [count === 0 ? 0 : this.indexAt(Math.max(0, this.total - height)), count];
  }

  #tally(group: string, size: number, count: number): void {
    const tally = this.#groups.get(group) ?? { sum: 0, count: 0 };
    tally.sum += size;
    tally.count += count;
    this.#groups.set(group, tally);
  }

  #build(): Float64Array {
    if (!this.#dirty) return this.#offsets;
    const count = this.#rows.length;

    if (this.#offsets.length !== count + 1) this.#offsets = new Float64Array(count + 1);
    let sum = 0;

    for (let index = 0; index < count; index++) {
      this.#offsets[index] = sum;
      sum += this.size(index);
    }

    this.#offsets[count] = sum;
    this.#dirty = false;

    return this.#offsets;
  }
}
