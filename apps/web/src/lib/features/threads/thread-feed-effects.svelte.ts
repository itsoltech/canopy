import type { FeedViewport } from "#lib/shared/ui/virtual/viewport.ts";
import type { FeedRow } from "./feed.ts";
import type { ThreadHistory } from "./history.svelte.ts";
import { prefetchWorkHistory } from "./work-history.ts";
import { untrack } from "svelte";
import type { WorkFolds, FoldReader } from "./work-folds.svelte.ts";
import type { ThreadState } from "./thread-state.svelte.ts";

/** Apply fold preferences before rendering without subscribing to the fold choices being updated. */
export function syncWorkFolds(
  read: () => {
    folds: WorkFolds;
    view: ThreadState;
    reader: FoldReader | undefined;
    preferences: { workWhileWorking: string; workAfterTurn: string };
  },
) {
  $effect.pre(() => {
    const { folds, view, reader, preferences } = read();
    const turns = [...view.inheritedTurns, ...view.ownTurns];
    const entries = [...view.inheritedEntries, ...view.ownEntries];
    const notices = view.notices;

    const settings = {
      expandWhileWorking: preferences.workWhileWorking === "expanded",
      keepAfterTurn: preferences.workAfterTurn === "keep-open",
    };

    const live = view.connection === "live";

    untrack(() => folds.update(turns, entries, notices, reader, settings, live));
  });
}

/** One bounded page at a time; errors require an explicit retry instead of a request loop. */
export function workHistoryPrefetch(read: () => { rows: readonly FeedRow[]; history: ThreadHistory }) {
  let window = $state<FeedViewport>({ start: 0, end: 0, height: 0 });

  $effect(() => {
    const { rows, history } = read();

    if (window.height > 0 && !history.loading && !history.error && prefetchWorkHistory(rows, window.start, window.end))
      void history.load();
  });

  return (value: FeedViewport) => (window = value);
}
