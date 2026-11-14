import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { SizeIndex } from "#lib/shared/ui/virtual/size-index.ts";
import { whenIdle } from "#lib/shared/idle.ts";
import { timelineRecovery } from "#lib/features/diagnostics/client.ts";
import { FeedBuilder, feedEstimate } from "./feed.ts";
import { threadCache } from "./thread-cache.ts";
import { ThreadState } from "./thread-state.svelte.ts";
import { WorkFolds } from "./work-folds.svelte.ts";

/** What a thread screen built and measured: a return shows it as it was left, then syncs what changed. */
export interface ThreadMemory {
  readonly view: ThreadState;
  readonly folds: WorkFolds;
  readonly builder: FeedBuilder;
  /** Measured row heights: a returning feed positions its rows before the first paint. */
  readonly sizes: SizeIndex;
}

interface Entry {
  readonly memory: ThreadMemory;
  /** Encoded size of the state when it was last left (protobuf bytes, not heap). */
  bytes: number;
  shown: number;
  cancel: () => void;
}

// About 1.9 MB encoded per 1000 loaded items; heap is roughly four times the encoded size.
export const THREAD_VIEW_LIMITS = { count: 12, bytes: 12 * 1024 * 1024 };

/**
 * Recently opened threads, kept whole in memory (LRU by count and encoded size). Leaving a thread keeps its
 * items, older pages, folds and row heights; background warming applies newer checkpoints to a thread off screen.
 * The visible thread owns its stream and is never evicted.
 */
class ThreadViews {
  readonly #entries = new Map<string, Entry>();

  constructor(readonly limits = THREAD_VIEW_LIMITS) {
    // A pairing change clears everything; a reset thread on screen keeps its view, which reloads from scratch.
    threadCache.onRelease((id) => {
      if (id === undefined) this.#entries.clear();
      else if (!this.#entries.get(id)?.shown) this.#entries.delete(id);
    });
  }

  get usage() {
    let bytes = 0;

    for (const entry of this.#entries.values()) bytes += entry.bytes;

    return { count: this.#entries.size, bytes };
  }

  /** The thread's retained state, or new state seeded from the cache (a header from the route load). */
  open(id: string, seed: ui.Thread | undefined): ThreadMemory {
    const entry = this.#entries.get(id) ?? {
      memory: {
        view: new ThreadState(seed?.id === id ? seed : undefined),
        folds: new WorkFolds(),
        builder: new FeedBuilder((count) => timelineRecovery("fold_derivation", count)),
        sizes: new SizeIndex(feedEstimate),
      },
      bytes: 0,
      shown: 0,
      cancel: () => {},
    };

    this.#entries.delete(id);
    this.#entries.set(id, entry);

    return entry.memory;
  }

  /** While a screen shows the thread it is not evicted; leaving caches its checkpoint and accounts its size. */
  show(id: string): () => void {
    const entry = this.#entries.get(id);

    if (!entry) return () => {};

    entry.shown++;
    entry.cancel();

    return () => this.#close(id, entry);
  }

  #close(id: string, entry: Entry): void {
    entry.shown = Math.max(0, entry.shown - 1);
    entry.cancel();
    entry.cancel = whenIdle(() => {
      const snapshot = entry.memory.view.snapshot;

      if (entry.shown || this.#entries.get(id) !== entry) return;

      if (snapshot?.thread && snapshot.cursor) {
        entry.bytes = toBinary(ui.ThreadSnapshotSchema, snapshot).byteLength;
        threadCache.set(snapshot, entry.bytes);
      }

      this.#trim();
    }, 1000);
  }

  snapshot(id: string): ui.ThreadSnapshot | undefined {
    return this.#entries.get(id)?.memory.view.snapshot;
  }

  /** Background warming read a newer checkpoint: a thread off screen takes it in place. */
  refresh(snapshot: ui.ThreadSnapshot): void {
    const entry = snapshot.thread && this.#entries.get(snapshot.thread.id);

    if (entry && !entry.shown)
      entry.memory.view.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } }));
  }

  #trim(): void {
    let { count, bytes } = this.usage;

    for (const [id, entry] of this.#entries) {
      if (count <= this.limits.count && bytes <= this.limits.bytes) return;

      if (entry.shown) continue;
      entry.cancel();
      this.#entries.delete(id);
      count--;
      bytes -= entry.bytes;
    }
  }
}

export const threadViews = new ThreadViews();
