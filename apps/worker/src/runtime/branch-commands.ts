import { realpathSync } from "node:fs";
import type { Command, SwitchThreadBranch, ThreadGitRequest } from "@canopy/contracts";
import { Journal } from "../journal/index.ts";
import { repoRoot } from "../git/refs.ts";
import { canonicalCheckoutRoot, matchingCheckoutPaths } from "../git/checkout-paths.ts";
import { boundedGit, GitError } from "../git/git.ts";
import { pullOrigin } from "../git/pull-origin.ts";
import { GitStatusReader } from "../git/status-reader.ts";
import { switchBranch } from "../git/switch-branch.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class BranchCommands {
  readonly #statuses = new GitStatusReader();

  constructor(readonly ctx: HostContext) {}

  async switchThreadBranch(kind: Extract<Command["kind"], { case: "switchThreadBranch" }>): Promise<CommandOutput> {
    try {
      return await boundedGit(kind.value.expiresAtMs, () => this.#switch(kind.value));
    } catch (error) {
      if (error instanceof GitError) throw new CommandError(error.code, error.message, true);
      throw error;
    }
  }

  async getThreadGitStatus(kind: Extract<Command["kind"], { case: "getThreadGitStatus" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.cwd);

    // Re-establish the live HEAD watch after a worker restart even before the next provider turn.
    const { threadId, cwd } = kind.value;
    const { state } = this.ctx;

    const destination = state.nextWorkspaces.get(threadId);

    if (
      threadId &&
      (!destination || destination === cwd) &&
      !state.closedThreads.has(threadId) &&
      !state.unloadingThreads.has(threadId)
    )
      void state.heads.track(threadId, cwd);

    try {
      const root = canonicalCheckoutRoot(kind.value.cwd);

      if (this.ctx.state.switchingPaths.has(root))
        throw new CommandError("CHECKOUT_BUSY", "A Git operation is in progress. Wait for it to finish.", true);

      return await boundedGit(kind.value.expiresAtMs, async () => ({
        threadGitStatus: await this.#statuses.read(root, kind.value.expiresAtMs),
      }));
    } catch (error) {
      if (error instanceof GitError) throw new CommandError(error.code, error.message, true);
      throw error;
    }
  }

  async pullThreadOrigin(kind: Extract<Command["kind"], { case: "pullThreadOrigin" }>): Promise<CommandOutput> {
    try {
      return await boundedGit(kind.value.expiresAtMs, () =>
        this.#checkout(kind.value, (root) =>
          pullOrigin({ ...kind.value, cwd: root }, () =>
            this.#statuses.read(canonicalCheckoutRoot(kind.value.cwd), kind.value.expiresAtMs),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof GitError) throw new CommandError(error.code, error.message, true);
      throw error;
    }
  }

  async #switch(request: SwitchThreadBranch): Promise<CommandOutput> {
    return this.#checkout(request, (root) => switchBranch({ ...request, cwd: root }));
  }

  async #checkout(
    request: Pick<ThreadGitRequest, "threadId" | "cwd"> &
      Partial<Pick<SwitchThreadBranch, "expectedCheckout" | "workspaceRepo">>,
    run: (root: string) => Promise<CommandOutput>,
  ): Promise<CommandOutput> {
    const { state } = this.ctx;
    this.ctx.ops.checkCwd(request.cwd);
    const known = request.threadId ? state.cwds.get(request.threadId) : undefined;

    // With an expected checkout the gateway holds the current binding lock. The native
    // session can still be parked in the previous cwd until its next turn.
    if (!request.expectedCheckout && known && realpathSync(known) !== realpathSync(request.cwd))
      throw new CommandError("INVALID_CHECKOUT", "This thread uses another directory. Refresh the thread.", true);

    const root = await repoRoot(request.cwd);

    if (!root) throw new CommandError("NOT_A_REPOSITORY", "This directory is not a git checkout.", true);

    if (request.expectedCheckout && request.expectedCheckout !== root)
      throw new CommandError("INVALID_CHECKOUT", "The working directory changed. Refresh and try again.", true);

    this.ctx.ops.checkCwd(request.cwd);

    if (state.switchingPaths.has(root))
      throw new CommandError("CHECKOUT_BUSY", "A Git operation is in progress. Wait for it to finish.", true);
    state.switchingPaths.add(root);

    try {
      if (request.workspaceRepo) {
        const discovered = await state.worktreeDiscovery.list(request.workspaceRepo, true);
        const selected = discovered.worktrees.find((tree) => tree.path === root);

        if (!selected || selected.unavailableReason || selected.locked || selected.prunable || selected.missing)
          throw new CommandError("INVALID_CHECKOUT", "Worktree unavailable. Refresh and choose a worktree.", true);
      }

      const paths = new Set(matchingCheckoutPaths(root, [...state.cwds.values()]));
      const ids = new Set([...state.cwds].flatMap(([id, cwd]) => (paths.has(cwd) ? [id] : [])));

      const turns = await state.options.runtime.runPromise(Journal.use((j) => j.openTurns()));
      const tasks = await state.options.runtime.runPromise(Journal.use((j) => j.openBackgroundTasks()));

      if (
        state.admitting ||
        turns.some((t) => ids.has(t.threadId)) ||
        tasks.some((t) => ids.has(t.threadId)) ||
        [...state.running].some((key) => ids.has(key.split("/")[0] ?? "")) ||
        [...state.interactions.values()].some(({ request }) => ids.has(request.threadId))
      )
        throw new CommandError("CHECKOUT_BUSY", "A thread is using this directory. Wait for its turn to finish.", true);

      await this.#statuses.settled(root);
      const result = await run(root);

      for (const id of ids) await state.heads.check(id);

      return result;
    } finally {
      state.worktreeDiscovery.clear();
      state.switchingPaths.delete(root);
    }
  }
}
