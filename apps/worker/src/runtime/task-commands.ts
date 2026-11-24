import { Provider, type Command } from "@canopy/contracts";
import { Context, Effect } from "effect";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { CodexThreads } from "../providers/codex/threads.ts";

import { CommandError, taskOf, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class TaskCommands {
  constructor(readonly ctx: HostContext) {}
  async setGoal(kind: Extract<Command["kind"], { case: "setGoal" }>): Promise<CommandOutput> {
    const { thread: spec, directive, objective, nativeTokenBudget } = kind.value;

    if (!spec) throw new CommandError("INVALID_COMMAND", "thread spec missing", true);
    await this.ctx.ops.prepareThread(spec.threadId);

    // Claude goals are /goal turns in the input stream (docs/goals.md); the gateway queues them as turns.
    if (spec.provider === Provider.CLAUDE)
      throw new CommandError("UNSUPPORTED", "Claude goals are set with /goal turns", true);

    return this.ctx.state.turnAdmissions.start(spec.threadId, async (current) => {
      if (!current()) return {};
      this.ctx.ops.assignThreadWorkspace(spec);
      await this.ctx.ops.runCodex(
        spec.provider,
        (threads) =>
          current() &&
          !this.ctx.state.closedThreads.has(spec.threadId) &&
          !this.ctx.state.unloadingThreads.has(spec.threadId)
            ? threads.setGoal(spec, directive, objective, nativeTokenBudget)
            : Effect.void,
        this.ctx.ops.codexGroupOf(spec.providerProfileId),
      );

      return {};
    });
  }

  async stopTask(kind: Extract<Command["kind"], { case: "stopTask" }>): Promise<CommandOutput> {
    const { threadId, taskId } = kind.value;

    const claude = [...this.ctx.state.claude].find(([, handle]) =>
      Context.get(handle.context, ClaudeThreads).backgroundTasks().get(threadId)?.includes(taskId),
    );

    const codexGroup = [...this.ctx.state.codex].find(([, codex]) =>
      Context.get(codex.context, CodexThreads).backgroundTasks().get(threadId)?.includes(taskId),
    )?.[0];

    if (claude) await this.ctx.ops.runClaude((threads) => threads.stopTask(threadId, taskId), claude[0], true);
    else if (codexGroup !== undefined)
      await this.ctx.ops.runCodex(Provider.CODEX, (threads) => threads.stopTask(threadId, taskId), codexGroup, true);
    // No process runs it: if the journal still has it open, its process is gone, so it ends here.
    else
      await this.ctx.ops.closeOrphans(
        (threadOf, item) => threadOf === threadId && taskOf(item) === taskId,
        "stopped_by_user",
      );

    return {};
  }

  async unloadThread(kind: Extract<Command["kind"], { case: "unloadThread" }>): Promise<CommandOutput> {
    await this.ctx.ops.releaseThread(kind.value.threadId);

    return {};
  }
}
