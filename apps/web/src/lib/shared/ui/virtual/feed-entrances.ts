export interface Entrance {
  readonly kind: "rise" | "reveal" | "unfold";
  readonly order: number;
}

/**
 * How the feed's rows enter: rows added at the end after the first snapshot rise in, rows inserted between known
 * ones enter as the feed's `inserted` says (staggered), each once, when it first mounts.
 */
export class FeedEntrances {
  /** Keys shown so far (undefined until the first rows); rows that arrive later enter until they mount. */
  private known: Set<string> | undefined;
  private readonly entering = new Map<string, Entrance>();
  private frame = 0;

  /** Takes in the feed's keys; `inserted` gives the entrance of the row at a position between known ones. */
  update(keys: readonly string[], inserted: (at: number) => "unfold" | "reveal" | undefined): void {
    if (keys.length === 0) return;

    if (this.known) {
      const known = this.known;
      let last = -1;
      keys.forEach((rowKey, at) => {
        if (known.has(rowKey)) last = at;
      });
      let order = 0;
      keys.forEach((rowKey, at) => {
        if (known.has(rowKey)) return;

        if (at > last) this.entering.set(rowKey, { kind: "rise", order: 0 });
        else {
          const kind = inserted(at);

          if (kind) this.entering.set(rowKey, { kind, order: order++ });
        }
      });
    }

    // The first rows (a thread just opened) appear as they are: no entrance, they replace the placeholder at once.
    // What did not mount with this update (scrolled away) is not new any more.
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.entering.clear());
    this.known = new Set(keys);
  }

  /** How a row enters the first time it mounts (once), if it is new. */
  take(rowKey: string): Entrance | undefined {
    const enter = this.entering.get(rowKey);
    this.entering.delete(rowKey);

    return enter;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
  }
}
