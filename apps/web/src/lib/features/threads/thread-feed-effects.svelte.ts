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

/**
 * One bounded page at a time; errors require an explicit retry instead of a request loop. `waiting` holds the first
 * reveal while the mounted window still shows loading rows for work a page will fill (bounded by the feed's
 * positioning timeout), so a cold open does not show gaps that collapse under the reader.
 */
export function workHistoryPrefetch(read: () => { rows: readonly FeedRow[]; history: ThreadHistory }) {
  let window = $state<FeedViewport>({ start: 0, end: 0, height: 0 });

  const missing = $derived.by(() => {
    const { rows, history } = read();

    return window.height > 0 && !history.error && prefetchWorkHistory(rows, window.start, window.end);
  });

  $effect(() => {
    if (missing && !read().history.loading) void read().history.load();
  });

  return {
    update: (value: FeedViewport) => (window = value),
    get waiting() {
      return missing;
    },
  };
}
