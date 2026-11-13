import type { ui } from "@canopy/contracts";
import { workState } from "./thread-activity.ts";
import { compareThreadOrder } from "./thread-order.ts";

export const THREAD_WARM_LIMITS = { recent: 12, count: 32, intervalMs: 2000, retryMs: 30_000 };

/** The archive never enters the set. Bound the union, including arbitrarily many working threads/pins. */
export function threadWarmSet(
  threads: readonly ui.Thread[],
  pinned: readonly string[],
  visible: readonly string[],
  limits = THREAD_WARM_LIMITS,
) {
  const pins = new Set(pinned);
  const eligible = threads.filter((thread) => !thread.deletedAt && thread.status !== "archived");
  const roots = new Set(visible);

  // Visibility follows sidebar filters; recency follows replies/creation, never
  // the display sort, manual ranks or pin position. Pins join independently below.
  const recent = new Set(
    eligible
      .filter((thread) => roots.has(thread.id))
      .sort((a, b) => compareThreadOrder(a, b, "activity"))
      .slice(0, limits.recent)
      .map((thread) => thread.id),
  );

  const priority = (thread: ui.Thread) =>
    recent.has(thread.id)
      ? 0
      : workState(thread) !== "idle"
        ? 1
        : thread.unseenResult || thread.markedUnread
          ? 2
          : pins.has(thread.id)
            ? 3
            : 4;

  return eligible
    .filter((thread) => priority(thread) < 4)
    .sort((a, b) => priority(a) - priority(b) || compareThreadOrder(a, b, "activity"))
    .slice(0, limits.count)
    .map((thread) => thread.id);
}

export function threadCacheCurrent(snapshot: ui.ThreadSnapshot | undefined, head: ui.ThreadSyncCursor | undefined) {
  const cursor = snapshot?.syncCursor;

  return (
    !!snapshot?.thread &&
    !!cursor &&
    !!head?.epoch &&
    cursor.threadId === head.threadId &&
    cursor.epoch === head.epoch &&
    cursor.appliedSeq >= head.appliedSeq
  );
}
