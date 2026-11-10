import { ui } from "@canopy/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";
import { isSide } from "@canopy/domain/thread-tree";
import { retain, sameItems } from "@canopy/domain/same-items";

export { groupSideThreads, isSide } from "@canopy/domain/thread-tree";

export interface ThreadTree {
  readonly main: ui.Thread;
  readonly sides: readonly ui.Thread[];
}

export interface SideMark {
  icon: IconName;
  iconClass: string;
}

/** The mark of a side thread in lists: violet sparkles when an agent started it, a copy for a fork, else a turn arrow. */
export function sideMark(thread: ui.Thread): SideMark {
  if (thread.spawnedByAgent) return { icon: "sparkles", iconClass: "text-violet-500 dark:text-violet-400" };

  return {
    icon: thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right",
    iconClass: "fill-zinc-400 dark:fill-zinc-600",
  };
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
    if (isSide(thread) && ids.has(thread.parentThreadId))
      sides.set(thread.parentThreadId, [...(sides.get(thread.parentThreadId) ?? []), thread]);
  }

  return threads
    .filter((t) => !(isSide(t) && ids.has(t.parentThreadId)))
    .sort(byCreation)
    .map((main) => ({ main, sides: (sides.get(main.id) ?? []).sort(byCreation) }));
}

/** The tree the given thread belongs to: the same tree `threadForest` builds, without building the others. */
export function treeOf(threads: readonly ui.Thread[], thread: ui.Thread): ThreadTree {
  const rootId = isSide(thread) && thread.parentThreadId ? thread.parentThreadId : thread.id;
  const main = threads.find((t) => t.id === rootId);

  // A main that is itself a side thread of a listed one is no root of the forest.
  if (!main || (isSide(main) && threads.some((t) => t.id === main.parentThreadId))) return { main: thread, sides: [] };

  return { main, sides: threads.filter((t) => isSide(t) && t.parentThreadId === rootId).sort(byCreation) };
}

const sameTree = (a: ThreadTree | undefined, b: ThreadTree | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.main === b.main && sameItems(a.sides, b.sides));

/** Every thread event rebuilds the index: the tree's readers (panel, lineage) rerun only when the tree changed. */
export const retainTree = () => retain(sameTree);
