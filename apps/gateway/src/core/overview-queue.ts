import { isDeepStrictEqual } from "node:util";
import type { ui } from "@canopy/contracts";

function sameState(before: ui.Thread, after: ui.Thread): boolean {
  if (before.lastSeq === after.lastSeq) return isDeepStrictEqual(before, after);

  // Only transcript progress during an ordinary running turn is replaceable. In particular,
  // notices use the original seq as their deduplication key.
  if (
    before.lastSeq > after.lastSeq ||
    after.status !== "running" ||
    after.pendingInteractions ||
    after.unseenResult ||
    after.turnStarting ||
    after.rewindPending ||
    after.archivedAt ||
    after.deletedAt
  )
    return false;

  // Compare all other fields, including nested messages, presence and unknown fields.
  // Shallow copies keep the published protos shared by other readers untouched.
  return isDeepStrictEqual({ ...before, lastSeq: after.lastSeq }, { ...after });
}

/** Remove superseded thread summaries only, leaving every surviving frame at its original position. */
export function compactOverview(pending: readonly ui.OverviewUpdate[]) {
  const removed = new Set<number>();
  const latest = new Map<string, { index: number; thread: ui.Thread }>();
  let barrier = -1;
  let fixedPrefix = 0;

  for (const [index, update] of pending.entries()) {
    const change = update.change;

    if (
      change.case !== "thread" ||
      !change.value.id ||
      change.value.nodeId ||
      update.$unknown?.length ||
      change.value.$unknown?.length
    ) {
      latest.clear();
      barrier = index;
      fixedPrefix = index + 1;
      continue;
    }

    const thread = change.value;
    const previous = latest.get(thread.id);

    if (!previous || !sameState(previous.thread, thread)) {
      // A first sighting or state transition may affect other rows (e.g. a child's pending approval).
      barrier = index;

      if (previous) {
        latest.clear();
        fixedPrefix = index;
      }
    } else if (previous.index >= barrier && previous.thread.lastSeq === thread.lastSeq) {
      // Keep the original frame, including its place relative to other entities.
      removed.add(index);
      continue;
    } else if (previous.index > barrier) {
      // Preserve the first observation of a state with its original seq as well as the latest
      // progress. This also preserves a decrease in seq relative to an already delivered frame.
      removed.add(previous.index);
    }

    latest.set(thread.id, { index, thread });
  }

  return { removed, fixedPrefix };
}
