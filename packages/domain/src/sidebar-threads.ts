import type { ui } from "@canopy/contracts";
import { needsYou } from "./thread-activity.ts";
import { compareThreadOrder, type ThreadSortMode } from "./thread-order.ts";
import { isThreadSnoozed } from "./thread-snooze.ts";
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

/** Archived children remain discoverable in Previous agents. Active pins are flat roots;
 * snoozed trees have their own section, including any pinned sides. */
export function sidebarThreads(
  threads: readonly ui.Thread[],
  settings: Pick<ui.SidebarSettings, "projectIds" | "pinnedThreadIds"> & { workerIds?: readonly string[] },
  query: string,
  projectName: (id: string) => string,
  sortMode: ThreadSortMode = "activity",
) {
  const projects = new Set(settings.projectIds);
  const workers = new Set(settings.workerIds);

  const eligible = threads.filter(
    (t) => !t.deletedAt && (!projects.size || projects.has(t.projectId)) && (!workers.size || workers.has(t.workerId)),
  );

  const ids = new Set(eligible.map((t) => t.id));
  const archivedParents = new Set(threads.flatMap((t) => (t.status === "archived" ? [t.id] : [])));
  const byId = new Map(threads.map((t) => [t.id, t]));

  const snoozedIds = new Set(
    eligible.flatMap((t) => (t.status !== "archived" && isThreadSnoozed(t, (id) => byId.get(id)) ? [t.id] : [])),
  );

  const pins = new Set(settings.pinnedThreadIds);
  const sides = new Map<string, ui.Thread[]>();
  const snoozedSides = new Map<string, ui.Thread[]>();

  // A visible parent's activity includes its subagents, even on a worker or project outside the filter.
  for (const t of threads) {
    if (!ids.has(t.parentThreadId) || t.deletedAt || (!t.spawnedByAgent && !ids.has(t.id))) continue;

    const parentSnoozed = snoozedIds.has(t.parentThreadId);

    if (!parentSnoozed && snoozedIds.has(t.id)) continue;
    const children = parentSnoozed ? snoozedSides : sides;
    const siblings = children.get(t.parentThreadId);

    if (siblings) siblings.push(t);
    else children.set(t.parentThreadId, [t]);
  }

  const q = query.trim().toLowerCase();

  const matches = (t: ui.Thread) =>
    !q || t.title.toLowerCase().includes(q) || projectName(t.projectId).toLowerCase().includes(q);

  const roots = eligible.filter((t) => {
    if (t.spawnedByAgent) return false;

    if (t.status === "archived") return false;

    if (snoozedIds.has(t.id)) return false;

    // Parent events arrive before their cascade children; never flash those children as active roots.
    if (isSide(t) && archivedParents.has(t.parentThreadId)) return false;

    if (pins.has(t.id)) return matches(t) || (sides.get(t.id) ?? []).some(matches);

    return !(isSide(t) && ids.has(t.parentThreadId)) && (matches(t) || (sides.get(t.id) ?? []).some(matches));
  });

  roots.sort((a, b) => {
    return Number(pins.has(b.id)) - Number(pins.has(a.id)) || compareThreadOrder(a, b, sortMode);
  });

  const snoozed = eligible.filter(
    (t) =>
      snoozedIds.has(t.id) &&
      !t.spawnedByAgent &&
      !archivedParents.has(t.parentThreadId) &&
      !snoozedIds.has(t.parentThreadId) &&
      (matches(t) || (snoozedSides.get(t.id) ?? []).some(matches)),
  );

  snoozed.sort((a, b) => compareThreadOrder(a, b, sortMode));

  return { roots, sides, pins, snoozed, snoozedSides };
}

/** An archived side under an active main belongs to Previous agents, including when it is current. */
export function collapsedArchivedThread(
  current: ui.Thread | undefined,
  expanded: boolean,
  threads: ReadonlyMap<string, ui.Thread>,
  projectIds: readonly string[],
  query: string,
  projectName: (id: string) => string,
  workerIds: readonly string[] = [],
): ui.Thread | undefined {
  if (expanded || !current || current.spawnedByAgent || current.deletedAt || current.status !== "archived") return;

  if (projectIds.length && !projectIds.includes(current.projectId)) return;

  if (workerIds.length && !workerIds.includes(current.workerId)) return;
  const q = query.trim().toLowerCase();

  if (q && !current.title.toLowerCase().includes(q) && !projectName(current.projectId).toLowerCase().includes(q))
    return;
  const parent = threads.get(current.parentThreadId);

  if (isSide(current) && parent && !parent.deletedAt && parent.status !== "archived") return;

  return current;
}
