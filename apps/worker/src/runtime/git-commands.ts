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
import { withProcessPriority } from "@canopy/process-governor";
import { listGitRefs, repoRoot } from "../git/refs.ts";
import { matchingCheckoutPaths } from "../git/checkout-paths.ts";
import { createWorktree, renameWorktreeBranch } from "../git/worktrees.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { workspaceOrigin } from "../git/origin.ts";
import { revealInFileManager } from "./reveal.ts";
import { cloneRepository, initRepository } from "../git/project-sources.ts";
import { WorktreeDiscovery, withKnownPaths } from "../git/discovery.ts";

/** Git worktrees (docs/worktrees.md): refs of a workspace, new worktrees and their branch names. */
export class GitCommands {
  readonly #creating = new Map<string, Promise<void>>();
  readonly #discovery = new WorktreeDiscovery();
  constructor(readonly ctx: HostContext) {}

  async readWorkspaceOrigin(kind: Extract<Command["kind"], { case: "readWorkspaceOrigin" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.repoPath);

    return workspaceOrigin(kind.value.repoPath, kind.value.includeCloneUrl);
  }

  async initRepository(kind: Extract<Command["kind"], { case: "initRepository" }>): Promise<CommandOutput> {
    return { directoryPath: await gitStep(() => initRepository(kind.value.parentPath, kind.value.name)) };
  }

  async cloneRepository(kind: Extract<Command["kind"], { case: "cloneRepository" }>): Promise<CommandOutput> {
    return {
      directoryPath: await gitStep(() => cloneRepository(kind.value.parentPath, kind.value.name, kind.value.url)),
    };
  }

  /** The managed root of new worktrees without a configured location. */
  get worktreesRoot(): string {
    return this.ctx.state.worktreeRoots.primary;
  }

  /** Every managed root: worktrees under the legacy `<data_dir>/worktrees` stay managed. */
  get managedRoots(): readonly string[] {
    return this.ctx.state.worktreeRoots.managed;
  }

  async listGitRefs(kind: Extract<Command["kind"], { case: "listGitRefs" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.repoPath);

    if (kind.value.branchesOnly)
      return gitStep(async () => {
        const root = await repoRoot(kind.value.repoPath);

        return {
          gitRefs: kind.value.worktreesOnly
            ? {
                isRepo: Boolean(root),
                repoRoot: root ?? "",
                sameCheckoutPaths: root ? matchingCheckoutPaths(root, kind.value.knownPaths) : [],
              }
            : await listGitRefs(kind.value.repoPath),
        };
      });

    return gitStep(async () => {
      const discovery = await this.#discovery
        .list(kind.value.repoPath, kind.value.freshWorktrees)
        .catch(() => undefined);

      const refs = kind.value.worktreesOnly
        ? { isRepo: Boolean(discovery), repoRoot: discovery?.repoRoot ?? "" }
        : await listGitRefs(kind.value.repoPath, kind.value.remote || "origin");

      return {
        gitRefs: {
          ...refs,
          worktrees: withKnownPaths(discovery?.worktrees ?? [], kind.value.knownPaths),
          worktreesDetail: discovery ? "" : "Worktrees unavailable. Refresh to retry.",
        },
      };
    });
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
        this.#discovery.clear();

        if (this.#creating.get(key) === settled) this.#creating.delete(key);
      }
    });
  }

  async renameWorktreeBranch(kind: Extract<Command["kind"], { case: "renameWorktreeBranch" }>): Promise<CommandOutput> {
    try {
      return { worktree: await gitStep(() => freshGit(() => renameWorktreeBranch(this.managedRoots, kind.value))) };
    } finally {
      this.#discovery.clear();
    }
  }

  async scanWorktrees(kind: Extract<Command["kind"], { case: "scanWorktrees" }>): Promise<CommandOutput> {
    const statuses = [];

    for (const target of kind.value.targets) {
      try {
        statuses.push(
          await withProcessPriority(kind.value.background ? "background" : "user", () =>
            freshGit(() => scanWorktree(this.managedRoots, target, kind.value.fetch)),
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
          worktreeBranchDeleted: await freshGit(() => removeWorktree(this.managedRoots, kind.value, idle, receipt)),
        };
      } finally {
        this.#discovery.clear();
        this.ctx.state.removingPaths.delete(path);
      }
    });
  }

  async revealWorktree(kind: Extract<Command["kind"], { case: "revealWorktree" }>): Promise<CommandOutput> {
    return gitStep(async () => {
      const { path } = await checkedWorktree(this.managedRoots, kind.value);
      await revealInFileManager(path);

      return {};
    });
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
