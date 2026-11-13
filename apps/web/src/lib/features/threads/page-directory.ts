import type { ui } from "@canopy/contracts";
import { turnQuoteTime } from "#lib/features/quotes/inline.ts";
import { provideThreadDirectory } from "./thread-directory.ts";
import type { ThreadState } from "./thread-state.svelte.ts";
import { isTerminal } from "./timeline.ts";

/** Live timeline context shared by message actions, quotes and provider items. */
export function providePageDirectory(
  source: () => {
    id: string;
    view: ThreadState;
    readOnly: boolean;
    canFork: boolean;
  },
  lookup: (id: string) => ui.Thread | undefined,
  reveal: (quote: ui.Quote) => Promise<boolean>,
) {
  provideThreadDirectory({
    get currentId() {
      return source().id;
    },
    get readOnly() {
      return source().readOnly;
    },
    get latestTurnId() {
      return source().view.turns.findLast(
        (turn) => !turn.rewindId && !turn.withdrawn && (turn.status !== "queued" || turn.dispatched),
      )?.id;
    },
    thread: lookup,
    awaiting: (id) => source().view.pending.some((interaction) => interaction.itemId === id),
    goal: (id) => (source().view.goal?.id === id ? source().view.goal : undefined),
    turnEnded: (id) => {
      const turn = source().view.turns.find((entry) => entry.id === id);

      return turn !== undefined && isTerminal(turn.status);
    },
    steer: (id) => source().view.steers.find((steer) => steer.id === id),
    quoteTime: (id) => turnQuoteTime(source().view.turns.find((turn) => turn.id === id)),
    item: (id) => source().view.ownEntries.find((entry) => entry.id === id)?.item,
    delivery: (id) => source().view.deliveries.get(id),
    get canFork() {
      return source().canFork;
    },
    get canRewind() {
      const { view, readOnly } = source();
      const thread = view.thread;

      return (
        !readOnly &&
        thread?.runtime === "worker" &&
        !thread.spawnedByAgent &&
        !thread.scheduleId &&
        thread.status !== "archived" &&
        !thread.rewindPending
      );
    },
    revealQuote: reveal,
  });
}
