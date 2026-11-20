import type { FeedViewport } from "#lib/shared/ui/virtual/viewport.ts";
import type { ReaderScroll } from "#lib/shared/ui/virtual/scroll.ts";
import { hasWorkHistoryGap } from "./work-history.ts";
import type { FeedRow } from "./feed.ts";
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

/** Scroll reads one page at a time. A gap button reads up to the selected turn, including a multi-page fold. */
export function workHistoryReader(view: () => ThreadState, rows: () => readonly FeedRow[]) {
  let generation = 0;

  $effect.pre(() => {
    view();

    return () => {
      generation++;
    };
  });

  function scroll({ up }: ReaderScroll, { start, end, height }: FeedViewport) {
    const { history } = view();

    if (up <= 0 || height <= 0 || history.loading || history.error) return;

    if (start < 4 || hasWorkHistoryGap(rows(), start, end)) void history.load();
  }

  async function show(key: string) {
    const opened = generation;
    const state = view();

    while (opened === generation && rows().some((row) => row.key === key)) {
      const before = state.snapshot;
      await state.history.load();
      const after = state.snapshot;

      if (!before || !after || after.historyVersion !== before.historyVersion) return;

      if (
        after.historyBeforeItemId === before.historyBeforeItemId &&
        after.historyBeforeTurnId === before.historyBeforeTurnId
      )
        return;
    }
  }

  return { scroll, show };
}
