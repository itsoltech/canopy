import { ui, type GitRefs } from "@canopy/contracts";
import { listGitRefs } from "./api.ts";
import { headLabel } from "@canopy/domain/git-heads";

/** Where a new thread works (docs/worktrees.md): the checkout, a new worktree or an earlier one. */
export type WorkspaceChoice =
  | { readonly kind: "checkout" }
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly worktree: ui.ThreadWorktree };

/** CreateThread's workspace fields, as the form sends them. */
export interface WorkspaceForm {
  readonly workspaceMode: "CHECKOUT" | "NEW_WORKTREE" | "EXISTING_WORKTREE";
  readonly baseRef: string;
  readonly worktreeId: string;
}

/** The icon of a workspace choice in the picker and its pill. */
export function choiceIcon(choice: WorkspaceChoice): "folder-open" | "square-2-stack" | "git-fork" {
  if (choice.kind === "checkout") return "folder-open";

  return choice.kind === "new" ? "square-2-stack" : "git-fork";
}

interface Picks {
  readonly workspaceId: string;
  readonly choice?: WorkspaceChoice;
  readonly baseRef?: string;
}

/**
 * The new-thread composer's workspace and base ref. Refs and earlier worktrees load per workspace while its worker
 * is online and offers worktrees; picks reset when the workspace changes. Until you pick: the default mode of the
 * worktree settings (project × computer).
 */
export class WorkspaceDraft {
  refs = $state.raw<ui.ListGitRefsResponse | undefined>(undefined);
  loading = $state(false);
  error = $state<string | undefined>(undefined);
  #picks = $state.raw<Picks>({ workspaceId: "" });
  #target: () => { workspaceId: string; ready: boolean } | undefined;
  #loaded = "";

  constructor(target: () => { workspaceId: string; ready: boolean } | undefined) {
    this.#target = target;
    $effect(() => {
      const current = this.#target();
      const key = current?.ready ? current.workspaceId : "";

      if (key !== this.#loaded) void this.#load(key);
    });
  }

  async #load(workspaceId: string): Promise<void> {
    this.#loaded = workspaceId;
    this.refs = undefined;
    this.error = undefined;
    this.loading = Boolean(workspaceId);

    if (!workspaceId) return;

    try {
      const refs = await listGitRefs(workspaceId);

      if (this.#loaded === workspaceId) this.refs = refs;
    } catch (cause) {
      if (this.#loaded === workspaceId) this.error = cause instanceof Error ? cause.message : "Refs are unavailable";
    } finally {
      if (this.#loaded === workspaceId) this.loading = false;
    }
  }

  /** Worktrees can be made here: a worker that supports them and a git repository. */
  get available(): boolean {
    return Boolean(this.refs?.supported && this.refs.refs?.isRepo);
  }

  get gitRefs(): GitRefs | undefined {
    return this.available ? this.refs?.refs : undefined;
  }

  get worktrees(): readonly ui.ThreadWorktree[] {
    return this.available ? (this.refs?.worktrees ?? []) : [];
  }

  #own(): Picks | undefined {
    return this.#picks.workspaceId === this.#loaded ? this.#picks : undefined;
  }

  get choice(): WorkspaceChoice {
    if (!this.available) return { kind: "checkout" };
    const picked = this.#own()?.choice;

    if (picked) return picked;

    return this.refs?.settings?.defaultMode === ui.WorkspaceMode.NEW_WORKTREE ? { kind: "new" } : { kind: "checkout" };
  }

  choose(choice: WorkspaceChoice): void {
    this.#picks = { ...this.#own(), workspaceId: this.#loaded, choice };
  }

  /** The base of a new worktree (default: the repository's default branch). */
  get baseRef(): string {
    return this.#own()?.baseRef || this.gitRefs?.defaultBranch || "";
  }

  chooseBase(ref: string): void {
    this.#picks = { ...this.#own(), workspaceId: this.#loaded, baseRef: ref };
  }

  /** The branch the thread shows next to the ref picker (read-only unless a new worktree). */
  get branch(): string {
    const choice = this.choice;

    if (choice.kind === "existing") return headLabel(choice.worktree);

    if (choice.kind === "new") return this.baseRef;

    return this.gitRefs?.currentBranch ?? "";
  }

  /** CreateThread's fields as form values. */
  get form(): WorkspaceForm {
    const choice = this.choice;

    if (choice.kind === "new") return { workspaceMode: "NEW_WORKTREE", baseRef: this.baseRef, worktreeId: "" };

    if (choice.kind === "existing")
      return { workspaceMode: "EXISTING_WORKTREE", baseRef: "", worktreeId: choice.worktree.id };

    return { workspaceMode: "CHECKOUT", baseRef: "", worktreeId: "" };
  }
}
