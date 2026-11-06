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
