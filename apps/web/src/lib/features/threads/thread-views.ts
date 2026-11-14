import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { RetainedThreads } from "@canopy/domain/retained-threads";
import { SizeIndex } from "#lib/shared/ui/virtual/size-index.ts";
import { whenIdle } from "#lib/shared/idle.ts";
import { timelineRecovery } from "#lib/features/diagnostics/client.ts";
import { FeedBuilder, feedEstimate } from "./feed.ts";
import { threadCache } from "./thread-cache.ts";
import { ThreadState } from "./thread-state.svelte.ts";
import { WorkFolds } from "./work-folds.svelte.ts";

/** What a thread screen built and measured: a return shows it as it was left, then syncs what changed. */
export class ThreadMemory {
  readonly folds = new WorkFolds();
  readonly builder = new FeedBuilder((count) => timelineRecovery("fold_derivation", count));
  /** Measured row heights: a returning feed positions its rows before the first paint. */
  readonly sizes = new SizeIndex(feedEstimate);

  constructor(readonly view: ThreadState) {}

  get snapshot() {
    return this.view.snapshot;
  }

  apply(snapshot: ui.ThreadSnapshot) {
    this.view.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } }));
  }
}

// About 1.9 MB encoded per 1000 loaded items; heap is roughly four times the encoded size.
export const THREAD_VIEW_LIMITS = { count: 12, bytes: 12 * 1024 * 1024 };

/** Recently opened threads (docs/client-performance.md); the visible one owns its stream and is never evicted. */
export const threadViews = new RetainedThreads<ThreadMemory>({
  ...THREAD_VIEW_LIMITS,
  idle: (task) => whenIdle(task, 1000),
  settled: (snapshot, bytes) => threadCache.set(snapshot, bytes),
});

// A pairing change clears everything; a reset thread on screen keeps its view, which reloads from scratch.
threadCache.onRelease((id) => (id === undefined ? threadViews.clear() : threadViews.forget(id)));

/** The thread's retained state, or new state seeded from the cache (a header from the route load). */
export function openThreadMemory(id: string, seed: ui.Thread | undefined): ThreadMemory {
  return threadViews.open(id, () => new ThreadMemory(new ThreadState(seed?.id === id ? seed : undefined)));
}
