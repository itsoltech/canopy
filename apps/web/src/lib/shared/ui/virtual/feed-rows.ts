import type { SizedRow } from "./size-index.ts";

/** Streamed content is not a structural change: keep indexes and entrances asleep until keys/groups change. */
export class FeedRows {
  #rows: readonly SizedRow[] = [];

  update<T>(rows: readonly T[], key: (row: T) => string, group: (row: T) => string): readonly SizedRow[] {
    if (
      rows.length === this.#rows.length &&
      rows.every((row, i) => key(row) === this.#rows[i]!.key && group(row) === this.#rows[i]!.group)
    )
      return this.#rows;

    this.#rows = rows.map((row) => ({ key: key(row), group: group(row) }));

    return this.#rows;
  }
}
