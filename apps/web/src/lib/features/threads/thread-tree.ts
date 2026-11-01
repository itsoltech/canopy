import { ui } from "@open-agents/contracts";

export interface ThreadTree {
  readonly main: ui.Thread;
  readonly sides: readonly ui.Thread[];
}

export const isSide = (thread: ui.Thread) => thread.kind === ui.ThreadKind.SIDE || Boolean(thread.parentThreadId);

const byCreation = (a: ui.Thread, b: ui.Thread) => Number((a.createdAt?.seconds ?? 0n) - (b.createdAt?.seconds ?? 0n));

/**
 * Two levels (docs/threads.md): main threads and their side threads. Side threads whose parent is not
 * in the list (archived, not loaded yet) are shown as their own roots so nothing disappears.
 */
export function threadForest(threads: readonly ui.Thread[]): ThreadTree[] {
  const ids = new Set(threads.map((t) => t.id));
  const sides = new Map<string, ui.Thread[]>();
  for (const thread of threads) {
    if (isSide(thread) && ids.has(thread.parentThreadId)) sides.set(thread.parentThreadId, [...(sides.get(thread.parentThreadId) ?? []), thread]);
  }
  return threads
    .filter((t) => !(isSide(t) && ids.has(t.parentThreadId)))
    .sort(byCreation)
    .map((main) => ({ main, sides: (sides.get(main.id) ?? []).sort(byCreation) }));
}

/** The tree the given thread belongs to. */
export function treeOf(threads: readonly ui.Thread[], thread: ui.Thread): ThreadTree {
  const rootId = isSide(thread) && thread.parentThreadId ? thread.parentThreadId : thread.id;
  return threadForest(threads).find((tree) => tree.main.id === rootId) ?? { main: thread, sides: [] };
}
