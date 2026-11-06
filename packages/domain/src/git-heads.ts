/** How a checkout's HEAD reads in the UI (docs/worktrees.md, "Bieżąca gałąź"): its branch or the detached commit. */
export function headLabel(head: { readonly branch: string; readonly detachedCommit: string }): string {
  return head.detachedCommit ? `Detached at ${head.detachedCommit}` : head.branch;
}
