import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, InteractionResponseSchema } from "@canopy/contracts";
import { Effect } from "effect";
import { CodexThreads } from "../providers/codex/threads.ts";
import { CommandError } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

/** Archive fences admission immediately; the durable unload command acknowledges only completed cleanup. */
export class ThreadResources {
  constructor(readonly ctx: HostContext) {}

  async prepareThread(threadId: string): Promise<void> {
    await this.ctx.state.threadCleanup.get(threadId);

    if (this.ctx.state.closedThreads.has(threadId))
      throw new CommandError(
        "THREAD_CLOSED",
        "This thread is archived or deleted. Unarchive or restore it to continue.",
        true,
      );

    if (this.ctx.state.unloadingThreads.has(threadId))
      throw new CommandError(
        "THREAD_CLEANUP_PENDING",
        "This thread is still closing. Wait a moment, then try again.",
        false,
      );
    await this.ctx.state.agentTools.threadOpened(threadId);

    if (this.ctx.state.closedThreads.has(threadId) || this.ctx.state.unloadingThreads.has(threadId))
      throw new CommandError(
        "THREAD_CLEANUP_PENDING",
        "This thread is still closing. Wait a moment, then try again.",
        false,
      );
    this.ctx.state.secrets.openThread(threadId);
  }

  releaseThread(threadId: string): Promise<void> {
    const state = this.ctx.state;
    const pending = state.threadCleanup.get(threadId);

    if (pending) return pending;
    state.unloadingThreads.add(threadId);
    state.agentTools.fenceThread(threadId);
    state.turnAdmissions.invalidate(threadId);
    state.heads.untrack(threadId);
    state.markdownImages.closeThread(threadId);
    state.imageExports.closeThread(threadId);
    state.secrets.closeThread(threadId);
    this.#cancelRequests(threadId);

    const closing = this.#release(threadId)
      .then(() => {
        state.unloadingThreads.delete(threadId);
      })
      .catch(() => {
        throw new CommandError(
          "THREAD_CLEANUP_PENDING",
          "This thread is still closing. Wait a moment, then try again.",
          false,
        );
      })
      .finally(() => {
        if (state.threadCleanup.get(threadId) === closing) state.threadCleanup.delete(threadId);
      });

    state.threadCleanup.set(threadId, closing);

    return closing;
  }

  async #release(threadId: string): Promise<void> {
    const state = this.ctx.state;
    const shells = [...state.shellRuns.values()].filter((run) => run.threadId === threadId);

    for (const run of shells) run.controller.abort();

    const local = Promise.allSettled([
      ...shells.map((run) => run.pending),
      this.ctx.ops.closeThreadResources(threadId),
      this.ctx.ops.stopThreadPreviews?.(threadId),
    ]);

    const first = await Promise.allSettled(this.#unloadProviders(threadId));
    const admission = await Promise.allSettled([state.turnAdmissions.drain(threadId)]);
    // A create/start may have been preparing its native session when the lifecycle update arrived.
    const second = await Promise.allSettled(this.#unloadProviders(threadId));
    const resources = await local;
    const native = await Promise.allSettled([state.agentTools.closeThread(threadId)]);

    state.heads.untrack(threadId);
    state.imageExports.closeThread(threadId);
    state.markdownImages.closeThread(threadId);
    state.secrets.closeThread(threadId);

    if ([...first, ...admission, ...second, ...native, ...resources].some((result) => result.status === "rejected"))
      throw new Error("Thread cleanup incomplete");
    await this.ctx.ops.closeOrphans((id) => id === threadId, "stopped_by_user");
  }

  #unloadProviders(threadId: string): Promise<void>[] {
    return [
      ...[...this.ctx.state.claude.keys()].map((id) =>
        this.ctx.ops.runClaude((threads) => threads.unload(threadId), id, true),
      ),
      ...[...this.ctx.state.codex.keys()].map((id) =>
        this.ctx.ops.useRuntime(`codex/${id}`, true, async () => {
          const handle = this.ctx.state.codex.get(id);

          if (handle)
            await this.ctx.ops.runIn(
              Effect.provide(
                CodexThreads.use((threads) => threads.unload(threadId)),
                handle.context,
              ),
            );
        }),
      ),
      ...[...this.ctx.state.grok.keys()].map((id) =>
        this.ctx.ops.runGrok((threads) => threads.unload(threadId), id, true),
      ),
    ];
  }

  #cancelRequests(threadId: string): void {
    for (const [id, pending] of this.ctx.state.interactions) {
      if (pending.request.threadId !== threadId) continue;
      this.ctx.state.interactions.delete(id);
      pending.resolve(create(InteractionResponseSchema, { requestId: id, cancelled: true }));
    }

    for (const [id, pending] of this.ctx.state.toolCalls) {
      if (pending.call.threadId !== threadId) continue;
      this.ctx.state.toolCalls.delete(id);
      pending.resolve(create(AgentToolResultSchema, { callId: id, isError: true, content: "Thread closed" }));
    }
  }
}
