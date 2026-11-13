/** Per-timeline tool group choices, independent of mounted rows and the outer work fold. */
export class WorkGroupChoices {
  readonly #manual = new Map<string, boolean>();
  readonly #opened = new Set<string>();

  /** Live defaults follow the device preference; ended groups retain their last visible state. */
  open(key: string, live: boolean, expanded: boolean): boolean {
    const manual = this.#manual.get(key);

    if (manual !== undefined) return manual;

    if (live) {
      if (expanded) this.#opened.add(key);
      else this.#opened.delete(key);
    }

    return this.#opened.has(key);
  }

  /** Explicit choices survive new items, preference changes, completion and virtualization. */
  choose(key: string, open: boolean): void {
    this.#manual.set(key, open);
  }
}
