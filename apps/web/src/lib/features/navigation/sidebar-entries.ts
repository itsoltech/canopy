import { ui } from "@canopy/contracts";
import { isCalm, needsYou, treeActivity } from "#lib/features/threads/activity.ts";

export interface SidebarEntry {
  key: string;
  thread?: ui.Thread;
  heading?: string;
  working?: boolean;
}

/** Sections are disjoint. A question or unseen result in any child keeps the whole tree out of Working. */
export function sidebarEntries(
  filtered: { roots: ui.Thread[]; sides: Map<string, ui.Thread[]>; pins: Set<string> },
  settings: ui.SidebarSettings,
  projects: readonly ui.Project[],
  workingOpen: boolean,
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  const tree = (t: ui.Thread) => [t, ...(filtered.sides.get(t.id) ?? []).filter((c) => c.status !== "archived")];
  const pinned = filtered.roots.filter((t) => filtered.pins.has(t.id));
  const rest = filtered.roots.filter((t) => !filtered.pins.has(t.id));

  const working = settings.workingSection
    ? rest.filter((t) => tree(t).some(isCalm) && !tree(t).some((c) => needsYou(c) || c.unseenResult))
    : [];

  const workingIds = new Set(working.map((t) => t.id));
  const active = rest.filter((t) => !workingIds.has(t.id));
  const attention = active.filter((t) => tree(t).some((c) => needsYou(c) || c.unseenResult));
  const attentionIds = new Set(attention.map((t) => t.id));
  const normal = settings.groupByProject ? active.filter((t) => !attentionIds.has(t.id)) : active;

  const add = (title: string, key: string, threads: readonly ui.Thread[]) => {
    if (!threads.length) return;
    entries.push({ key: `heading:${key}`, heading: title });

    for (const thread of threads) entries.push({ key: thread.id, thread });
  };

  add("Pinned", "pinned", pinned);

  if (settings.groupByProject) {
    add("Needs attention", "attention", attention);

    const groups = [...new Set(normal.map((t) => t.projectId))].map((id) => ({
      id,
      project: projects.find((p) => p.id === id),
      threads: normal.filter((t) => t.projectId === id),
    }));

    groups.sort((a, b) =>
      settings.projectOrder === ui.ProjectOrder.NAME
        ? (a.project?.name ?? "").localeCompare(b.project?.name ?? "")
        : settings.projectOrder === ui.ProjectOrder.CREATED
          ? Number((b.project?.createdAt?.seconds ?? 0n) - (a.project?.createdAt?.seconds ?? 0n))
          : Number(treeActivity(b.threads.flatMap(tree)) - treeActivity(a.threads.flatMap(tree))),
    );

    for (const group of groups) add(group.project?.name ?? "Project", group.id, group.threads);
  } else add("Threads", "threads", normal);

  if (working.length) {
    entries.push({ key: "heading:working", heading: `Working (${working.length})`, working: true });

    if (workingOpen) for (const thread of working) entries.push({ key: thread.id, thread });
  }

  return entries;
}
