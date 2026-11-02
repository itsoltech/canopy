import { ui } from "@open-agents/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";

export interface ThreadTree {
  readonly main: ui.Thread;
  readonly sides: readonly ui.Thread[];
}

export const isSide = (thread: ui.Thread) => thread.kind === ui.ThreadKind.SIDE || Boolean(thread.parentThreadId);

/** Shared by sidebar and Lineage; deleted threads are never a previous agent. */
export function groupSideThreads(threads: readonly ui.Thread[]) {
  const visible = threads.filter((t) => !t.deletedAt);
  return {
    active: visible.filter((t) => t.status !== "archived").sort(byCreation),
    previous: visible.filter((t) => t.status === "archived").sort((a, b) => Number((b.archivedAt?.seconds ?? b.createdAt?.seconds ?? 0n) - (a.archivedAt?.seconds ?? a.createdAt?.seconds ?? 0n))),
  };
}

/** The mark of a side thread in lists: violet sparkles when an agent started it, a copy for a fork, else a turn arrow. */
export function sideMark(thread: ui.Thread): { icon: IconName; iconClass: string } {
  if (thread.spawnedByAgent) return { icon: "sparkles", iconClass: "fill-violet-500 dark:fill-violet-400" };
  return { icon: thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right", iconClass: "fill-zinc-400 dark:fill-zinc-600" };
}

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
