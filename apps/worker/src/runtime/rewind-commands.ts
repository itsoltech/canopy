import { create } from "@bufbuild/protobuf";
import { InterruptTurnSchema, StopTaskSchema, Provider, type RewindThread, type ThreadSpec } from "@canopy/contracts";
import { Context } from "effect";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { Journal } from "../journal/index.ts";

/** The gateway's durable intent fences admission; the worker closes native continuation sources too. */
export class RewindCommands {
  constructor(readonly ctx: HostContext) {}

  async rewindThread(request: RewindThread): Promise<CommandOutput> {
    const spec = request.thread;

    if (!spec) throw new CommandError("INVALID_COMMAND", "thread spec missing", true);
    this.ctx.ops.checkCwd(spec.cwd);

    if (spec.provider === Provider.GROK)
      throw new CommandError("REWIND_UNSUPPORTED", "Edit from here is not available for this agent.", true);

    if (request.restoreFiles && spec.provider !== Provider.CLAUDE)
      throw new CommandError("REWIND_FILES_UNSUPPORTED", "Files stay as they are. Choose conversation only.", true);

    if (!request.preview) {
      if (this.ctx.state.rewindingThreads.has(spec.threadId))
        throw new CommandError("REWIND_BUSY", "This thread is already rewinding.", true);
      this.ctx.state.rewindingThreads.add(spec.threadId);

      try {
        for (const turnId of request.cancelledTurnIds)
          await this.ctx.state.options.runtime.runPromise(
            Journal.use((journal) => journal.noteInterrupt(spec.threadId, turnId)),
          );
        await this.#stop(spec.threadId);

        // turn_finished clears its interrupt receipt. Fence any queued old StartTurn again after stopping.
        for (const turnId of request.cancelledTurnIds)
          await this.ctx.state.options.runtime.runPromise(
            Journal.use((journal) => journal.noteInterrupt(spec.threadId, turnId)),
          );
        const result = await this.#replace(request, spec);
        await this.ctx.state.options.runtime.runPromise(Journal.use((journal) => journal.forgetRequest(spec.threadId)));

        return result;
      } finally {
        this.ctx.state.rewindingThreads.delete(spec.threadId);
      }
    }

    return this.#replace(request, spec);
  }

  async #replace(request: RewindThread, spec: ThreadSpec): Promise<CommandOutput> {
    const rewind =
      spec.provider === Provider.CLAUDE
        ? await this.ctx.ops.runClaude((threads) => threads.rewind(request), spec.providerProfileId || "native", true)
        : await this.ctx.ops.runCodex(
            Provider.CODEX,
            (threads) => threads.rewind(request),
            this.ctx.ops.codexGroupOf(spec.providerProfileId),
            true,
          );

    return { rewind };
  }

  async #stop(threadId: string): Promise<void> {
    const running = [...this.ctx.state.running].find((key) => key.startsWith(`${threadId}/`));

    if (running) {
      await this.ctx.ops.interruptTurn({
        case: "interruptTurn",
        value: create(InterruptTurnSchema, { threadId, turnId: running.slice(threadId.length + 1) }),
      });
      const deadline = Date.now() + 15_000;

      while ([...this.ctx.state.running].some((key) => key.startsWith(`${threadId}/`))) {
        if (Date.now() >= deadline)
          throw new CommandError("REWIND_BUSY", "The agent is still stopping. Try editing again.", true);
        await Bun.sleep(25);
      }
    }

    const tasks = new Set([
      ...[...this.ctx.state.claude.values()].flatMap(
        (handle) => Context.get(handle.context, ClaudeThreads).backgroundTasks().get(threadId) ?? [],
      ),
      ...[...this.ctx.state.codex.values()].flatMap(
        (handle) => Context.get(handle.context, CodexThreads).backgroundTasks().get(threadId) ?? [],
      ),
    ]);

    for (const taskId of tasks)
      await this.ctx.ops.stopTask({ case: "stopTask", value: create(StopTaskSchema, { threadId, taskId }) });
  }
}
