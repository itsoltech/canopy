import type { ui } from "@canopy/contracts";
import { basename } from "./humanize.ts";

/** Thread list placement: scratch, checkout HEAD, then the directory for non-worktree threads. */
export function threadPlace(thread: ui.Thread, project?: ui.Project): string {
  if (project?.kind === "scratch") return "scratch folder";

  return (thread.worktree && headLabel(thread.worktree)) || basename(thread.cwd);
}

/** Where a sidebar row says the thread runs; an empty value is not shown. */
export interface ThreadRowPlace {
  readonly place: string;
  /** What the row shows: the branch name or, with a detached HEAD, the short commit. */
  readonly branch: string;
  /** The full name for the title and the accessible name ("Branch main", "Detached at 3f2a9c1"). */
  readonly branchLabel: string;
}

/**
 * The sidebar row's meta line (docs/threads.md, "Wiersz wątku"): the place and the live git branch, each shown once.
 * A worktree's place is its branch; a workspace directory named like its project only repeats the row's first line.
 * Threads without a known git HEAD (no repository, older worker) keep the directory and show no branch.
 */
export function threadRowPlace(thread: ui.Thread, project?: ui.Project): ThreadRowPlace {
  const head = project?.kind === "scratch" ? undefined : (thread.worktree ?? thread.checkoutHead);
  const branch = head?.detachedCommit || head?.branch;

  if (!head || !branch) return { place: threadPlace(thread, project), branch: "", branchLabel: "" };

  const directory = basename(thread.cwd);

  return {
    place: thread.worktree || directory === project?.name ? "" : directory,
    branch,
    branchLabel: head.detachedCommit ? headLabel(head) : `Branch ${branch}`,
  };
}

/** How a checkout's HEAD reads in the UI (docs/worktrees.md, "Bieżąca gałąź"): its branch or the detached commit. */
export function headLabel(head: { readonly branch: string; readonly detachedCommit: string }): string {
  return head.detachedCommit ? `Detached at ${head.detachedCommit}` : head.branch;
}

/** Shown with a provisional branch name (docs/worktrees.md, "Nazwy gałęzi"). */
export const PROVISIONAL_BRANCH_HINT = "Canopy renames this branch when the task is clear.";

/** Keep the worktree directory distinguishable when several paths share a long home/project prefix. */
export function shortWorktreePath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);

  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

/** The worktree tooltip: its path, and the hint while its branch name is provisional. */
export function worktreeTooltip(worktree: { readonly path: string; readonly provisionalBranch: boolean }): string {
  return worktree.provisionalBranch
    ? `Worktree ${worktree.path}. ${PROVISIONAL_BRANCH_HINT}`
    : `Worktree ${worktree.path}`;
}

export { branchSwitchReason, placementPath } from "./thread-branch.ts";
