import type { ui } from "@canopy/contracts";
import { basename } from "./humanize.ts";
import { headLabel } from "./git-heads.ts";
import type { SidebarEntry } from "./sidebar-entries.ts";

export interface SidebarGrouping {
  groupByWorktree?: boolean;
}

/** Group identity follows the directory on its computer, never a mutable branch name. */
export function projectSidebarEntries(
  id: string,
  name: string,
  threads: readonly ui.Thread[],
  grouping: SidebarGrouping,
  workspaces: readonly ui.Workspace[] = [],
): SidebarEntry[] {
  const key = `heading:project:${id}`;

  const entries: SidebarEntry[] = [
    { key, heading: name, groupKind: "project", projectId: threads[0]?.projectId, count: threads.length },
  ];

  if (!grouping.groupByWorktree) {
    return [
      ...entries,
      ...threads.map((thread) => ({ key: thread.id, thread, groupedProject: true, depth: 1 as const })),
    ];
  }

  const groups = new Map<string, { directory: string; threads: ui.Thread[] }>();

  for (const thread of threads) {
    const directory =
      thread.worktree?.path ||
      workspaces.find((workspace) => workspace.id === thread.workspaceId)?.rootPath ||
      thread.cwd;

    const identity = JSON.stringify([id, thread.nodeId, thread.workerId, directory]);
    const members = groups.get(identity);

    if (members) members.threads.push(thread);
    else groups.set(identity, { directory, threads: [thread] });
  }

  for (const [identity, { directory, threads: members }] of groups) {
    const first = members[0]!;
    const head = first.worktree ?? first.checkoutHead;
    const label = head && headLabel(head);

    entries.push({
      key: `heading:worktree:${identity}`,
      heading: label || basename(directory) || "Main checkout",
      groupKind: "worktree",
      depth: 1,
      groupTitle: directory,
      count: members.length,
    });

    for (const thread of members) entries.push({ key: thread.id, thread, groupedProject: true, depth: 2 });
  }

  return entries;
}

/** Search reveals matches without changing the saved disclosure state. */
export function visibleSidebarEntries(
  entries: readonly SidebarEntry[],
  collapsed: readonly string[],
  searching: boolean,
): readonly SidebarEntry[] {
  if (searching || !collapsed.length) return entries;
  const hidden = new Set(collapsed);
  let projectHidden = false;
  let worktreeHidden = false;

  return entries.filter((entry) => {
    if (entry.heading && entry.groupKind !== "worktree") {
      projectHidden = false;
      worktreeHidden = false;
    }

    if (entry.groupKind === "project") {
      projectHidden = hidden.has(entry.key);

      return true;
    }

    if (entry.groupKind === "worktree") {
      worktreeHidden = hidden.has(entry.key);

      return !projectHidden;
    }

    return !projectHidden && !worktreeHidden;
  });
}
