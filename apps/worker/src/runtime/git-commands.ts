import { WorktreeStatusSchema, type Command } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { Journal } from "../journal/index.ts";
import { checkedWorktree, scanWorktree } from "../git/worktree-status.ts";
import { removeWorktree } from "../git/remove-worktree.ts";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isWithin } from "../git/worktrees.ts";
import { recoverRemoval } from "../git/remove-worktree.ts";
import { freshGit, gitOk, GitError } from "../git/git.ts";
import { runProcess, withProcessPriority } from "@canopy/process-governor";
import { listGitRefs } from "../git/refs.ts";
import { createWorktree, managedWorktreesRoot, renameWorktreeBranch } from "../git/worktrees.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { workspaceOrigin } from "../git/origin.ts";

/** Git worktrees (docs/worktrees.md): refs of a workspace, new worktrees and their branch names. */
export class GitCommands {
  readonly #creating = new Map<string, Promise<void>>();
  constructor(readonly ctx: HostContext) {}

  async readWorkspaceOrigin(kind: Extract<Command["kind"], { case: "readWorkspaceOrigin" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.repoPath);

    return { workspaceOrigin: await workspaceOrigin(kind.value.repoPath) };
  }

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
      const next = previous.then(() => freshGit(() => createWorktree(this.worktreesRoot, kind.value)));

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
    return { worktree: await gitStep(() => freshGit(() => renameWorktreeBranch(this.worktreesRoot, kind.value))) };
  }

  async scanWorktrees(kind: Extract<Command["kind"], { case: "scanWorktrees" }>): Promise<CommandOutput> {
    const statuses = [];

    for (const target of kind.value.targets) {
      try {
        statuses.push(
          await withProcessPriority(kind.value.background ? "background" : "user", () =>
            scanWorktree(this.worktreesRoot, target, kind.value.fetch),
          ),
        );
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        statuses.push(
          create(WorktreeStatusSchema, {
            id: target.id,
            detail: error.message,
            missing: error.code === "WORKTREE_NOT_FOUND",
          }),
        );
      }
    }

    return { worktreeStatuses: statuses };
  }

  async removeWorktree(
    kind: Extract<Command["kind"], { case: "removeWorktree" }>,
    commandId: string,
  ): Promise<CommandOutput> {
    return gitStep(async () => {
      if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new GitError("INVALID_COMMAND", "invalid removal command id");
      const receipt = join(this.ctx.state.options.dataDir, "worktree-removals", commandId);

      if (await recoverRemoval(receipt, kind.value)) return { worktreeBranchDeleted: false };
      const path = realpathSync(kind.value.target?.path ?? "");

      if (this.ctx.state.removingPaths.has(path)) throw new GitError("WORKTREE_BUSY", "cleanup already in progress");
      this.ctx.state.removingPaths.add(path);

      try {
        const idle = async () => {
          const state = this.ctx.state;

          const ids = new Set(
            [...state.cwds].flatMap(([id, cwd]) => (existsSync(cwd) && isWithin(path, realpathSync(cwd)) ? [id] : [])),
          );

          const tasks = await state.options.runtime.runPromise(Journal.use((j) => j.openBackgroundTasks()));
          const turns = await state.options.runtime.runPromise(Journal.use((j) => j.openTurns()));

          if (
            state.admitting ||
            tasks.some((t) => ids.has(t.threadId)) ||
            turns.some((t) => ids.has(t.threadId)) ||
            [...state.interactions.values()].some(({ request }) => ids.has(request.threadId)) ||
            [...state.running].some((key) => ids.has(key.split("/")[0] ?? ""))
          )
            throw new GitError("WORKTREE_BUSY", "a thread is still using this worktree");
        };

        await idle();

        return {
          worktreeBranchDeleted: await freshGit(() => removeWorktree(this.worktreesRoot, kind.value, idle, receipt)),
        };
      } finally {
        this.ctx.state.removingPaths.delete(path);
      }
    });
  }

  async revealWorktree(kind: Extract<Command["kind"], { case: "revealWorktree" }>): Promise<CommandOutput> {
    return gitStep(async () => {
      const { path } = await checkedWorktree(this.worktreesRoot, kind.value);

      const args = revealArgs(path);

      try {
        const result = await runProcess({ argv: args, timeoutMs: 5_000 }, { kind: "utility" });

        if (result.code !== 0)
          throw new GitError("REVEAL_FAILED", "The file manager could not open the folder. Copy the path instead.");
      } catch {
        throw new GitError(
          "REVEAL_UNAVAILABLE",
          "No file manager is available on this computer. Copy the path instead.",
        );
      }

      return {};
    });
  }
}

function revealArgs(path: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", "-R", path];
    case "win32":
      return ["explorer.exe", path];
    default:
      return ["xdg-open", path];
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
