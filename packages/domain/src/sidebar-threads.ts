import type { ui } from "@canopy/contracts";
import { needsYou, treeActivity } from "./thread-activity.ts";
import { groupSideThreads, isSide } from "./thread-tree.ts";

export const isArchivedSidebarThread = (thread: ui.Thread | undefined): thread is ui.Thread =>
  !!thread && !thread.spawnedByAgent && !thread.deletedAt && thread.status === "archived";

/** Pinned side threads already have their own row. Subagents only surface as attention on their parent. */
export function sidebarChildren(children: readonly ui.Thread[], rootIds: ReadonlySet<string> = new Set()) {
  return {
    sides: groupSideThreads(children.filter((t) => !t.spawnedByAgent && !rootIds.has(t.id))),
    subagentsNeedingInput: children.filter((t) => !t.deletedAt && t.spawnedByAgent && needsYou(t)),
  };
}

/** One visibility rule for project/search/archive filtering; archived children remain discoverable in
 * Previous agents. Pins are flat roots so a pinned side thread is visible even with its parent closed. */
export function sidebarThreads(
  threads: readonly ui.Thread[],
  settings: ui.SidebarSettings,
  query: string,
  projectName: (id: string) => string,
) {
  const selected = new Set(settings.projectIds);
  const eligible = threads.filter((t) => !t.deletedAt && (!selected.size || selected.has(t.projectId)));
  const ids = new Set(eligible.map((t) => t.id));
  const archivedParents = new Set(threads.flatMap((t) => (t.status === "archived" ? [t.id] : [])));
  const pins = new Set(settings.pinnedThreadIds);
  const sides = new Map<string, ui.Thread[]>();

  for (const t of eligible)
    if (isSide(t) && ids.has(t.parentThreadId))
      sides.set(t.parentThreadId, [...(sides.get(t.parentThreadId) ?? []), t]);
  const q = query.trim().toLowerCase();

  const matches = (t: ui.Thread) =>
    !q || t.title.toLowerCase().includes(q) || projectName(t.projectId).toLowerCase().includes(q);

  const roots = eligible.filter((t) => {
    if (t.spawnedByAgent) return false;

    if (t.status === "archived") return false;

    // Parent events arrive before their cascade children; never flash those children as active roots.
    if (isSide(t) && archivedParents.has(t.parentThreadId)) return false;

    if (pins.has(t.id)) return matches(t) || (sides.get(t.id) ?? []).some(matches);

    return !(isSide(t) && ids.has(t.parentThreadId)) && (matches(t) || (sides.get(t.id) ?? []).some(matches));
  });

  roots.sort((a, b) => {
    const aTree = [a, ...(sides.get(a.id) ?? []).filter((t) => t.status !== "archived")];
    const bTree = [b, ...(sides.get(b.id) ?? []).filter((t) => t.status !== "archived")];

    return (
      Number(pins.has(b.id)) - Number(pins.has(a.id)) ||
      Number(bTree.some(needsYou)) - Number(aTree.some(needsYou)) ||
      Number(treeActivity(bTree) - treeActivity(aTree))
    );
  });

  return { roots, sides, pins };
}

/** An archived side under an active main belongs to Previous agents, including when it is current. */
export function collapsedArchivedThread(
  current: ui.Thread | undefined,
  expanded: boolean,
  threads: ReadonlyMap<string, ui.Thread>,
  projectIds: readonly string[],
  query: string,
  projectName: (id: string) => string,
): ui.Thread | undefined {
  if (expanded || !current || current.spawnedByAgent || current.deletedAt || current.status !== "archived") return;

  if (projectIds.length && !projectIds.includes(current.projectId)) return;
  const q = query.trim().toLowerCase();

  if (q && !current.title.toLowerCase().includes(q) && !projectName(current.projectId).toLowerCase().includes(q))
    return;
  const parent = threads.get(current.parentThreadId);

  if (isSide(current) && parent && !parent.deletedAt && parent.status !== "archived") return;

  return current;
}
