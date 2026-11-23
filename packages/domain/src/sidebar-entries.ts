import { ui } from "@canopy/contracts";
import type { ProjectChoice } from "./projects.ts";
import { isCalm, needsYou, treeActivity, unseenResult } from "./thread-activity.ts";
import { projectSidebarEntries, type SidebarGrouping } from "./sidebar-groups.ts";

export interface SidebarEntry {
  key: string;
  thread?: ui.Thread;
  heading?: string;
  working?: boolean;
  groupedProject?: boolean;
  depth?: 1 | 2;
  projectId?: string | undefined;
  groupKind?: "project" | "worktree";
  groupTitle?: string;
  groupWorkspaceId?: string | undefined;
  groupWorktreeId?: string | undefined;
  count?: number;
}

/** Subagent results stay inside the thread; an ongoing turn takes precedence over its earlier results. */
const needsAttention = (thread: ui.Thread) =>
  needsYou(thread) || (!thread.spawnedByAgent && !isCalm(thread) && unseenResult(thread) !== undefined);

/** Sections are disjoint. User input and visible results keep the whole tree out of Working. */
export function sidebarEntries(
  filtered: { roots: ui.Thread[]; sides: Map<string, ui.Thread[]>; pins: Set<string> },
  settings: ui.SidebarSettings,
  projects: readonly ProjectChoice[],
  workingOpen: boolean,
  grouping: SidebarGrouping = {},
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  const tree = (t: ui.Thread) => [t, ...(filtered.sides.get(t.id) ?? []).filter((c) => c.status !== "archived")];
  const pinned = filtered.roots.filter((t) => filtered.pins.has(t.id));
  const rest = filtered.roots.filter((t) => !filtered.pins.has(t.id));

  const working = settings.workingSection
    ? rest.filter((t) => tree(t).some(isCalm) && !tree(t).some(needsAttention))
    : [];

  const workingIds = new Set(working.map((t) => t.id));
  const active = rest.filter((t) => !workingIds.has(t.id));
  const attention = active.filter((t) => tree(t).some(needsAttention));
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

    const projectId = (thread: ui.Thread) =>
      projects.find((p) => p.projectIds.includes(thread.projectId))?.id ?? thread.projectId;

    const groups = [...new Set(normal.map(projectId))].map((id) => ({
      id,
      project: projects.find((p) => p.id === id),
      threads: normal.filter((t) => projectId(t) === id),
    }));

    groups.sort((a, b) =>
      settings.projectOrder === ui.ProjectOrder.NAME
        ? (a.project?.name ?? "").localeCompare(b.project?.name ?? "")
        : settings.projectOrder === ui.ProjectOrder.CREATED
          ? Number((b.project?.createdAt?.seconds ?? 0n) - (a.project?.createdAt?.seconds ?? 0n))
          : Number(treeActivity(b.threads.flatMap(tree)) - treeActivity(a.threads.flatMap(tree))),
    );

    for (const group of groups)
      entries.push(
        ...projectSidebarEntries(
          group.id,
          group.project?.name ?? "Project",
          group.threads,
          grouping,
          group.project?.workspaces,
        ),
      );
  } else add("Threads", "threads", normal);

  if (working.length) {
    entries.push({ key: "heading:working", heading: `Working (${working.length})`, working: true });

    if (workingOpen) for (const thread of working) entries.push({ key: thread.id, thread });
  }

  return entries;
}
