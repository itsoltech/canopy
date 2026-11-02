import type { ui } from "@open-agents/contracts";
import { needsYou, treeActivity } from "#lib/features/threads/activity.ts";
import { isSide } from "#lib/features/threads/thread-tree.ts";

/** One visibility rule for project/search/archive filtering; archived children remain discoverable in
 * Previous agents. Pins are flat roots so a pinned side thread is visible even with its parent closed. */
export function sidebarThreads(threads: readonly ui.Thread[], settings: ui.SidebarSettings, query: string, projectName: (id: string) => string) {
  const selected = new Set(settings.projectIds);
  const eligible = threads.filter((t) => !t.deletedAt && (!selected.size || selected.has(t.projectId)));
  const ids = new Set(eligible.map((t) => t.id));
  const pins = new Set(settings.pinnedThreadIds);
  const sides = new Map<string, ui.Thread[]>();
  for (const t of eligible) if (isSide(t) && ids.has(t.parentThreadId)) sides.set(t.parentThreadId, [...(sides.get(t.parentThreadId) ?? []), t]);
  const q = query.trim().toLowerCase();
  const matches = (t: ui.Thread) => !q || t.title.toLowerCase().includes(q) || projectName(t.projectId).toLowerCase().includes(q);
  const roots = eligible.filter((t) => {
    if ((t.status === "archived") !== settings.archived) return false;
    if (settings.archived || pins.has(t.id)) return matches(t) || (sides.get(t.id) ?? []).some(matches);
    return !(isSide(t) && ids.has(t.parentThreadId) && eligible.some((p) => p.id === t.parentThreadId && p.status !== "archived"))
      && (matches(t) || (sides.get(t.id) ?? []).some(matches));
  });
  roots.sort((a, b) => {
    const aTree = [a, ...(sides.get(a.id) ?? []).filter((t) => t.status !== "archived")];
    const bTree = [b, ...(sides.get(b.id) ?? []).filter((t) => t.status !== "archived")];
    return Number(pins.has(b.id)) - Number(pins.has(a.id)) || Number(bTree.some(needsYou)) - Number(aTree.some(needsYou)) || Number(treeActivity(bTree) - treeActivity(aTree));
  });
  return { roots, sides, pins };
}
