import type { SizedRow } from "./size-index.ts";

/** Streamed content is not a structural change: keep indexes and entrances asleep until keys/groups change. */
export class FeedRows<T> {
  #rows: readonly SizedRow[] = [];
  #source: readonly T[] = [];
  #key: ((row: T) => string) | undefined;
  #group: ((row: T) => string) | undefined;

  /** Rows are immutable; key/group are pure projections of a row. */
  update(rows: readonly T[], key: (row: T) => string, group: (row: T) => string): readonly SizedRow[] {
    const sameProjection = key === this.#key && group === this.#group;

    const same =
      rows.length === this.#rows.length &&
      rows.every(
        (row, i) =>
          (sameProjection && row === this.#source[i]) ||
          (key(row) === this.#rows[i]!.key && group(row) === this.#rows[i]!.group),
      );

    this.#source = rows;
    this.#key = key;
    this.#group = group;

    if (!same) this.#rows = rows.map((row) => ({ key: key(row), group: group(row) }));

    return this.#rows;
  }
}
