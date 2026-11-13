import { forkSession, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { RewindThread } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ThreadRewindResultSchema } from "@canopy/contracts";
import { Effect } from "effect";
import { fail, type ClaudeThreadContext } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import { rewindClaudeFiles } from "./rewind-files.ts";

export function claudeRewind(ctx: ClaudeThreadContext, runtime: ReturnType<typeof claudeRuntime>) {
  return Effect.fn("ClaudeThreads.rewind")(function* (request: RewindThread) {
    const spec = request.thread;

    if (!spec) throw new Error("thread spec missing");
    const profile = ctx.options.profile(spec.providerProfileId);

    if (!profile) throw new Error("provider instance unavailable");
    const instance = runtime.runtimeOf(profile);

    return yield* Effect.tryPromise({
      catch: fail(spec.threadId, "rewind"),
      try: async (): Promise<MessageInitShape<typeof ThreadRewindResultSchema>> => {
        const session = ctx.sessions.get(spec.threadId);

        if (session?.turn && !request.preview) throw new Error("Stop the running turn before editing.");

        if (!request.preview && session) {
          session.closing = true;
          session.abort.abort();
          session.query.close();
          await session.done;
          ctx.sessions.delete(spec.threadId);
        }

        let files: MessageInitShape<typeof ThreadRewindResultSchema> = {};

        if (request.checkpointId && (request.preview || request.restoreFiles)) {
          const result = await rewindClaudeFiles(request, {
            ...runtime.queryRuntime(profile, instance),
            cwd: spec.cwd,
          });

          files = {
            filesAvailable: result.canRewind,
            files: result.filesChanged ?? [],
            filesDetail: result.error ?? "",
          };

          if (request.restoreFiles && (!result.canRewind || result.skippedLinks))
            throw new Error("Some files could not be restored. Review the files, then retry with conversation only.");
        }

        if (request.preview) return files;

        if (request.restoreProviderThreadId) {
          const original = await runtime.inHome(instance.home, () =>
            getSessionInfo(request.restoreProviderThreadId, { dir: spec.cwd }),
          );

          if (!original) throw new Error("The original agent session is unavailable. The rewind remains in place.");

          return { providerThreadId: request.restoreProviderThreadId };
        }

        if (request.empty) return { ...files, providerThreadId: Bun.randomUUIDv7() };

        if (!request.afterProviderTurnRef || !request.sourceProviderThreadId)
          throw new Error("The rewind point is unavailable. Choose an earlier message.");

        const fork = await runtime.inHome(instance.home, () =>
          forkSession(request.sourceProviderThreadId, {
            dir: spec.cwd,
            upToMessageId: request.afterProviderTurnRef,
          }),
        );

        return { ...files, providerThreadId: fork.sessionId };
      },
    });
  });
}
