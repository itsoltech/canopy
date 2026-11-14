import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

/** A thread's client state kept after its screen closed (a view model around one snapshot). */
export interface RetainedThread {
  readonly snapshot: ui.ThreadSnapshot | undefined;
  apply(snapshot: ui.ThreadSnapshot): void;
}

interface Entry<T> {
  readonly memory: T;
  /** Encoded size when last accounted (protobuf bytes, not heap). */
  bytes: number;
  shown: number;
  /** Warming replaced its window: keep the loaded pages and let the screen's own watch fill the gap. */
  behind: boolean;
  cancel: () => void;
}

export interface RetainedThreadOptions {
  readonly count: number;
  readonly bytes: number;
  /** Runs work that can wait for an idle moment; returns its cancel. */
  readonly idle: (task: () => void) => () => void;
  /** A thread left or refreshed off screen: its checkpoint for the snapshot cache. */
  readonly settled?: (snapshot: ui.ThreadSnapshot, bytes: number) => void;
}

/**
 * Recently opened threads kept whole in memory (LRU by count and encoded size), so a return shows the loaded pages
 * and syncs only the delta. Background warming updates a thread off screen in place; a warm that could only read a
 * fresh bounded window (the thread moved far ahead) never replaces loaded pages: the thread stays behind, and its
 * cursor resumes when it opens. Shown threads are never evicted.
 */
export class RetainedThreads<T extends RetainedThread> {
  readonly #entries = new Map<string, Entry<T>>();

  constructor(readonly options: RetainedThreadOptions) {}

  get usage() {
    let bytes = 0;

    for (const entry of this.#entries.values()) bytes += entry.bytes;

    return { count: this.#entries.size, bytes };
  }

  /** The reader's state, including a view behind the warmer's checkpoint; does not change LRU order. */
  peek(id: string): T | undefined {
    return this.#entries.get(id)?.memory;
  }

  /** The thread's retained state, else `create`'s; most recently used. */
  open(id: string, create: () => T): T {
    const entry = this.#entries.get(id) ?? { memory: create(), bytes: 0, shown: 0, behind: false, cancel: () => {} };
    this.#entries.delete(id);
    this.#entries.set(id, entry);

    return entry.memory;
  }

  /** While a screen shows the thread it owns its watch and is not evicted; the returned function leaves it. */
  show(id: string): () => void {
    const entry = this.#entries.get(id);

    if (!entry) return () => {};

    entry.shown++;
    entry.behind = false;
    entry.cancel();

    return () => {
      entry.shown = Math.max(0, entry.shown - 1);
      this.#account(id, entry);
    };
  }

  /** The checkpoint warming continues from; none while behind (warming then uses its own cache). */
  snapshot(id: string): ui.ThreadSnapshot | undefined {
    const entry = this.#entries.get(id);

    return entry && !entry.behind ? entry.memory.snapshot : undefined;
  }

  /**
   * Warming read a newer checkpoint (`replaced`: a fresh window instead of the records after this one). True when a
   * retained thread took it; it then reaches `settled` once accounted.
   */
  refresh(snapshot: ui.ThreadSnapshot, replaced: boolean): boolean {
    const id = snapshot.thread?.id ?? "";
    const entry = this.#entries.get(id);

    if (!entry || entry.shown || entry.behind) return false;

    if (replaced) {
      entry.behind = true;

      return false;
    }

    entry.memory.apply(snapshot);
    this.#account(id, entry);

    return true;
  }

  /** A reset or removed thread; a shown one keeps its state (its screen reloads it). */
  forget(id: string): void {
    const entry = this.#entries.get(id);

    if (!entry || entry.shown) return;
    entry.cancel();
    this.#entries.delete(id);
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.cancel();
    this.#entries.clear();
  }

  #account(id: string, entry: Entry<T>): void {
    entry.cancel();
    entry.cancel = this.options.idle(() => {
      const snapshot = entry.memory.snapshot;

      if (entry.shown || this.#entries.get(id) !== entry) return;

      if (snapshot?.thread && snapshot.cursor) {
        entry.bytes = toBinary(ui.ThreadSnapshotSchema, snapshot).byteLength;

        // An idle leave may finish after a warm fallback; never roll that cache copy back to this old cursor.
        if (!entry.behind) this.options.settled?.(snapshot, entry.bytes);
      }

      this.#trim();
    });
  }

  #trim(): void {
    let { count, bytes } = this.usage;

    for (const [id, entry] of this.#entries) {
      if (count <= this.options.count && bytes <= this.options.bytes) return;

      if (entry.shown) continue;
      entry.cancel();
      this.#entries.delete(id);
      count--;
      bytes -= entry.bytes;
    }
  }
}
