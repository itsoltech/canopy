import { tick } from "svelte";
import { highlightCitation } from "#lib/shared/ui/highlight-citation.ts";
import type { FeedRow } from "./feed.ts";
import type { ThreadState } from "./thread-state.svelte.ts";
import type { ThreadRewind } from "./rewind-state.svelte.ts";
import type { WorkFolds } from "./work-folds.svelte.ts";
import { topLevelEntry } from "./timeline.ts";

interface QuoteRevealContext {
  readonly view: ThreadState;
  readonly folds: WorkFolds;
  readonly rewind: ThreadRewind;
  readonly rows: readonly FeedRow[];
  readonly feed: { reveal(key: string): Promise<boolean> } | undefined;
  readonly region: HTMLElement | undefined;
  readonly openHistory: () => void;
}

/**
 * A quote may load history and mount rows. Navigation cancels it before reading the next view.
 * True means handled, including silent cancellation; false means the active view could not reveal the source.
 */
export function createQuoteReveal(threadId: () => string, read: () => QuoteRevealContext) {
  let version = 0;

  $effect.pre(() => {
    threadId();

    return () => {
      version++;
    };
  });

  return async (itemId: string): Promise<boolean> => {
    const started = version;
    const { view, folds, rewind, openHistory } = read();

    if (!view.entries.some((entry) => entry.id === itemId)) await view.history.load(itemId);

    if (started !== version) return true;
    const own = view.ownEntries.find((entry) => entry.id === itemId);
    const inherited = own ? undefined : view.inheritedEntries.find((entry) => entry.id === itemId);
    const entry = own ?? inherited;

    if (!entry) return false;
    const top = topLevelEntry(own ? view.ownEntries : view.inheritedEntries, entry);

    if (inherited) openHistory();
    const rewound = own && view.ownTurns.find((turn) => turn.id === own.turnId)?.rewindId;

    if (rewound) rewind.show(rewound);
    const fold = folds.foldOf(top.id);

    if (fold && !folds.open.has(fold)) folds.toggle(fold, true);
    await tick();

    if (started !== version) return true;
    const group = read().rows.find((row) => row.kind === "work-group" && row.items.includes(`item:${top.id}`));

    if (group) folds.toggleGroup(group.key.replace(/^history:[^:]+:/, ""), true);
    await tick();

    if (started !== version) return true;
    const { rows, feed } = read();

    const target = rows.find(
      (row) =>
        (row.kind === "timeline" || row.kind === "answer") &&
        row.row?.kind === "item" &&
        row.row.node.entry.id === top.id,
    );

    if (!target) return false;
    const revealed = await feed?.reveal(target.key);

    if (started !== version) return true;

    if (!revealed) return false;
    await tick();

    if (started !== version) return true;
    const element = read().region?.querySelector<HTMLElement>(`[data-quote-item="${CSS.escape(entry.id)}"]`);

    if (!element) return true;
    element.scrollIntoView({ block: "nearest" });
    highlightCitation(element);

    return true;
  };
}
