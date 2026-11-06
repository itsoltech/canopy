import { headLabel } from "@canopy/domain/git-heads";
import { useEffect, useState } from "react";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";

/** Where a new thread works (docs/worktrees.md): the checkout, a new worktree or an earlier one. */
export type WorkspaceChoice =
  | { readonly kind: "checkout" }
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly worktree: ui.ThreadWorktree };

interface Picks {
  readonly workspaceId: string;
  readonly choice?: WorkspaceChoice;
  readonly baseRef?: string;
}

/**
 * The new thread's workspace and base ref, as on the web: refs and earlier worktrees load for the workspace while its
 * worker is online and offers worktrees; picks reset when the workspace changes. Until you pick, the worktree
 * settings' default mode (project × computer) decides.
 */
export function useWorkspaceDraft(workspaceId: string | undefined, ready: boolean) {
  const { client } = useSession();
  const key = ready && workspaceId ? workspaceId : "";
  const [loaded, setLoaded] = useState<{ workspaceId: string; refs: ui.ListGitRefsResponse }>();
  const [picks, setPicks] = useState<Picks>({ workspaceId: "" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;

    if (client && key)
      void client.api
        .listGitRefs({ workspaceId: key })
        .then((refs) => {
          if (active) setLoaded({ workspaceId: key, refs });
        })
        // Without refs the thread works in the checkout, as before worktrees.
        .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [client, key, refreshKey]);

  const refs = loaded?.workspaceId === key ? loaded.refs : undefined;
  const available = Boolean(key && refs?.supported && refs.refs?.isRepo);
  const gitRefs = available ? refs?.refs : undefined;
  const own = picks.workspaceId === key ? picks : undefined;

  const choice: WorkspaceChoice = !available
    ? { kind: "checkout" }
    : (own?.choice ??
      (refs?.settings?.defaultMode === ui.WorkspaceMode.NEW_WORKTREE ? { kind: "new" } : { kind: "checkout" }));

  const baseRef = own?.baseRef || gitRefs?.defaultBranch || "";

  return {
    available,
    refresh: () => setRefreshKey((value) => value + 1),
    gitRefs,
    worktrees: available ? (refs?.worktrees ?? []) : [],
    choice,
    baseRef,
    /** The branch shown next to the workspace pill (editable only for a new worktree). */
    branch:
      choice.kind === "existing"
        ? headLabel(choice.worktree)
        : choice.kind === "new"
          ? baseRef
          : gitRefs?.currentBranch,
    choose: (next: WorkspaceChoice) => setPicks({ ...own, workspaceId: key, choice: next }),
    chooseBase: (ref: string) => setPicks({ ...own, workspaceId: key, baseRef: ref }),
    /** CreateThread's workspace fields. */
    form:
      choice.kind === "new"
        ? { workspaceMode: ui.WorkspaceMode.NEW_WORKTREE, baseRef, worktreeId: "" }
        : choice.kind === "existing"
          ? { workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE, baseRef: "", worktreeId: choice.worktree.id }
          : { workspaceMode: ui.WorkspaceMode.CHECKOUT, baseRef: "", worktreeId: "" },
  };
}

export type WorkspaceDraft = ReturnType<typeof useWorkspaceDraft>;
