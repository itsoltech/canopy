import type { Command } from "@canopy/contracts";
import { realpathSync } from "node:fs";
import { gitOk, GitError } from "../git/git.ts";
import { listGitRefs } from "../git/refs.ts";
import { createWorktree, managedWorktreesRoot, renameWorktreeBranch } from "../git/worktrees.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

/** Git worktrees (docs/worktrees.md): refs of a workspace, new worktrees and their branch names. */
export class GitCommands {
  readonly #creating = new Map<string, Promise<void>>();
  constructor(readonly ctx: HostContext) {}

  /** `<data_dir>/worktrees`: the managed root of new worktrees without a configured location. */
  get worktreesRoot(): string {
    return managedWorktreesRoot(this.ctx.state.options.dataDir);
  }

  async listGitRefs(kind: Extract<Command["kind"], { case: "listGitRefs" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.repoPath);

    return { gitRefs: await gitStep(() => listGitRefs(kind.value.repoPath, kind.value.remote || "origin")) };
  }

  async createWorktree(kind: Extract<Command["kind"], { case: "createWorktree" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.repoPath);

    return gitStep(async () => {
      const common = await gitOk(
        kind.value.repoPath,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "NOT_A_REPOSITORY",
      );

      const key = realpathSync(common.trim());
      const previous = this.#creating.get(key) ?? Promise.resolve();
      const next = previous.then(() => createWorktree(this.worktreesRoot, kind.value));

      const settled = next.then(
        () => {},
        () => {},
      );

      this.#creating.set(key, settled);

      try {
        return { worktree: await next };
      } finally {
        if (this.#creating.get(key) === settled) this.#creating.delete(key);
      }
    });
  }

  async renameWorktreeBranch(kind: Extract<Command["kind"], { case: "renameWorktreeBranch" }>): Promise<CommandOutput> {
    return { worktree: await gitStep(() => renameWorktreeBranch(this.worktreesRoot, kind.value)) };
  }
}

/** Git's failures are final (the same request fails again); their code and message reach the gateway. */
async function gitStep<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitError) throw new CommandError(error.code, error.message, true);
    throw error;
  }
}
