import { realpathSync } from "node:fs";
import type { Command, SwitchThreadBranch } from "@canopy/contracts";
import { Journal } from "../journal/index.ts";
import { repoRoot } from "../git/refs.ts";
import { matchingCheckoutPaths } from "../git/checkout-paths.ts";
import { boundedGit, GitError } from "../git/git.ts";
import { switchBranch } from "../git/switch-branch.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class BranchCommands {
  constructor(readonly ctx: HostContext) {}

  async switchThreadBranch(kind: Extract<Command["kind"], { case: "switchThreadBranch" }>): Promise<CommandOutput> {
    try {
      return await boundedGit(kind.value.expiresAtMs, () => this.#switch(kind.value));
    } catch (error) {
      if (error instanceof GitError) throw new CommandError(error.code, error.message, true);
      throw error;
    }
  }

  async #switch(request: SwitchThreadBranch): Promise<CommandOutput> {
    const { state } = this.ctx;
    this.ctx.ops.checkCwd(request.cwd);
    const known = state.cwds.get(request.threadId);

    if (known && realpathSync(known) !== realpathSync(request.cwd))
      throw new CommandError("INVALID_CHECKOUT", "This thread uses another directory. Refresh the thread.", true);

    const root = await repoRoot(request.cwd);

    if (!root) throw new CommandError("NOT_A_REPOSITORY", "This directory is not a git checkout.", true);

    if (state.switchingPaths.has(root))
      throw new CommandError("CHECKOUT_BUSY", "A branch switch is in progress. Wait for it to finish.", true);
    state.switchingPaths.add(root);

    try {
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

      const switchedHead = await switchBranch(request);
      await state.heads.check(request.threadId);

      return { switchedHead };
    } finally {
      state.switchingPaths.delete(root);
    }
  }
}
