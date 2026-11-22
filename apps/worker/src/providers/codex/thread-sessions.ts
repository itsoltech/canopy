import type { v2 } from "@canopy/codex-protocol";
import type { ForkSpec, ThreadSpec, RewindThread } from "@canopy/contracts";
import { Effect, Semaphore } from "effect";
import { threadParams as paramsOf } from "./thread-params.ts";

import { CodexThreadError, fail, type Entry, type CodexThreadContext } from "./thread-types.ts";
import { registerThread } from "./thread-registry.ts";
import { dynamicTools } from "./dynamic-tools.ts";
import { assertWarmSandbox, codexSandboxProfile, verifySandboxResponse } from "./sandbox-profile.ts";

const NO_ROLLOUT = /no rollout found/i;

const prepareThread = (ctx: CodexThreadContext, spec: ThreadSpec, operation: string, entry?: Entry) =>
  Effect.gen(function* () {
    const profile = yield* codexSandboxProfile(ctx, spec);

    if (entry) yield* assertWarmSandbox(spec, entry, profile);

    const params = yield* Effect.try({
      try: () => paramsOf(ctx, spec, profile),
      catch: (cause) => fail(spec.threadId, operation)(cause instanceof Error ? cause : new Error(String(cause))),
    });

    return { params, profile };
  });

const announceThread = (ctx: CodexThreadContext, entry: Entry, replaces = "") =>
  ctx.journal
    .append(entry.platformId, {
      body: {
        case: "threadReady",
        value: { providerThreadId: entry.codexId, ...(replaces && { replacesProviderThreadId: replaces }) },
      },
    })
    .pipe(Effect.tap((event) => Effect.sync(() => ctx.options.publish(event))));

function reconfigureThread(ctx: CodexThreadContext, spec: ThreadSpec, entry: Entry) {
  const { codex } = ctx;

  return Effect.gen(function* () {
    if (entry.pendingTurns.length || [...entry.codexToPlatform.keys()].some((id) => !entry.finishedTurns.has(id)))
      return yield* new CodexThreadError({
        threadId: spec.threadId,
        operation: "connectors",
        message: "A turn is still running",
      });
    const { params, profile } = yield* prepareThread(ctx, spec, "connectors", entry);

    // 0.164 rejoins subscribed sessions and ignores overrides. Unsubscribe first: an idle
    // session with config overrides is then rebuilt from its durable history, retaining its ID.
    yield* codex
      .request("thread/unsubscribe", { threadId: entry.codexId })
      .pipe(Effect.mapError(fail(spec.threadId, "connectors")));
    const resumed = yield* resumeThread(ctx, spec, entry.codexId, { ...params, excludeTurns: true }, "connectors");

    if (resumed) {
      yield* verifySandboxResponse(ctx, spec, profile, resumed);

      return entry;
    }

    // An empty session has no rollout until its first turn.
    const started = yield* startThread(ctx, spec, params, "connectors");
    yield* verifySandboxResponse(ctx, spec, profile, started);
    ctx.byCodex.delete(entry.codexId);
    const replacement = registerThread(ctx, spec.threadId, started.thread.id, started.thread.path, profile);
    yield* announceThread(ctx, replacement, entry.codexId).pipe(Effect.mapError(fail(spec.threadId, "journal")));

    return replacement;
  });
}

/** Resume retains the original developer messages even when its configuration overrides change. */
function resumeInstructions(ctx: CodexThreadContext, spec: ThreadSpec, codexId: string, instructions: string) {
  return ctx.codex
    .request("thread/inject_items", {
      threadId: codexId,
      items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] }],
    })
    .pipe(Effect.mapError(fail(spec.threadId, "instructions")));
}

function startThread(
  ctx: CodexThreadContext,
  spec: ThreadSpec,
  params: ReturnType<typeof paramsOf>,
  operation: string,
) {
  return ctx.codex
    .request("thread/start", {
      ...params,
      experimentalRawEvents: true,
      ...dynamicTools(spec, ctx.options.viewImage !== undefined),
    })
    .pipe(Effect.mapError(fail(spec.threadId, operation)));
}

function resumeThread(
  ctx: CodexThreadContext,
  spec: ThreadSpec,
  threadId: string,
  params: Omit<v2.ThreadResumeParams, "threadId">,
  operation = "resume",
) {
  return ctx.codex
    .request("thread/resume", { threadId, ...params })
    .pipe(
      Effect.catch((error) =>
        NO_ROLLOUT.test(error.message) ? Effect.succeed(undefined) : Effect.fail(fail(spec.threadId, operation)(error)),
      ),
    );
}

export function threadSessions(ctx: CodexThreadContext) {
  const { options, codex, byPlatform } = ctx;
  const loading = Semaphore.makeUnsafe(1);

  const register = registerThread.bind(undefined, ctx);

  const ensureLoaded = (spec: ThreadSpec, recoveryContext = "") =>
    Effect.gen(function* () {
      const loaded = byPlatform.get(spec.threadId);

      if (loaded) {
        const profile = yield* codexSandboxProfile(ctx, spec);
        yield* assertWarmSandbox(spec, loaded, profile);

        return loaded;
      }

      if (!spec.providerThreadId) {
        return yield* new CodexThreadError({
          threadId: spec.threadId,
          operation: "resume",
          message: "thread was never created on Codex",
        });
      }

      const { params, profile } = yield* prepareThread(ctx, spec, "resume");

      // Archive shuts down the native session and moves its rollout. Restore its original path
      // before imported-session repair or cold resume; this does not load a native session.
      yield* codex.request("thread/unarchive", { threadId: spec.providerThreadId }).pipe(Effect.ignore);

      const path = yield* Effect.try({
        try: () => options.importedResumePath?.(spec, params.modelProvider),
        catch: (cause) => fail(spec.threadId, "resume")(cause instanceof Error ? cause : new Error(String(cause))),
      });

      const resumed = yield* resumeThread(ctx, spec, spec.providerThreadId, { ...params, ...(path && { path }) });

      if (resumed) {
        yield* verifySandboxResponse(ctx, spec, profile, resumed);
        yield* resumeInstructions(ctx, spec, resumed.thread.id, params.developerInstructions);

        return register(spec.threadId, resumed.thread.id, resumed.thread.path, profile);
      }

      // Codex writes a thread's rollout with its first turn: a thread that never had one is gone with the
      // process that created it. Nothing is lost by starting it again; the gateway keeps the platform
      // thread and takes the new Codex id (thread_ready replaces the old one).
      const started = yield* startThread(
        ctx,
        spec,
        {
          ...params,
          developerInstructions: [params.developerInstructions, recoveryContext].filter(Boolean).join("\n\n"),
        },
        "resume",
      );

      yield* verifySandboxResponse(ctx, spec, profile, started);
      const entry = register(spec.threadId, started.thread.id, started.thread.path, profile);
      yield* announceThread(ctx, entry, spec.providerThreadId).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry;
    }).pipe(loading.withPermit);

  return {
    ensureLoaded,
    reconfigure: (spec: ThreadSpec, entry: Entry) => reconfigureThread(ctx, spec, entry),
    rewind: Effect.fn("CodexThreads.rewind")(function* (request: RewindThread) {
      const spec = request.thread;

      if (!spec) return yield* fail("", "rewind")({ message: "thread spec missing" });

      if (request.preview) return {};
      const previous = byPlatform.get(spec.threadId);
      const { params, profile } = yield* prepareThread(ctx, spec, "rewind", previous);

      if (previous) {
        yield* codex
          .request("thread/unsubscribe", { threadId: previous.codexId })
          .pipe(Effect.mapError(fail(spec.threadId, "rewind")));
        ctx.byCodex.delete(previous.codexId);
        byPlatform.delete(spec.threadId);
      }

      if (request.restoreProviderThreadId) {
        const response = yield* codex
          .request("thread/resume", { threadId: request.restoreProviderThreadId, ...params })
          .pipe(Effect.mapError(fail(spec.threadId, "restore rewind")));

        yield* verifySandboxResponse(ctx, spec, profile, response);
        yield* resumeInstructions(ctx, spec, response.thread.id, params.developerInstructions);
        const entry = register(spec.threadId, response.thread.id, response.thread.path, profile);

        return { providerThreadId: entry.codexId };
      }

      if (!request.empty && (!request.afterProviderTurnRef || !request.sourceProviderThreadId))
        return yield* new CodexThreadError({
          threadId: spec.threadId,
          operation: "rewind",
          message: "The rewind point is unavailable. Choose an earlier message.",
        });

      const response = request.empty
        ? yield* startThread(ctx, spec, params, "rewind")
        : yield* codex
            .request("thread/fork", {
              ...params,
              threadId: request.sourceProviderThreadId,
              lastTurnId: request.afterProviderTurnRef,
            })
            .pipe(Effect.mapError(fail(spec.threadId, "rewind")));

      yield* verifySandboxResponse(ctx, spec, profile, response);

      if (!request.empty) yield* resumeInstructions(ctx, spec, response.thread.id, params.developerInstructions);
      register(spec.threadId, response.thread.id, response.thread.path, profile);

      return { providerThreadId: response.thread.id };
    }),
    create: Effect.fn("CodexThreads.create")(function* (spec: ThreadSpec, fork?: ForkSpec) {
      const loaded = byPlatform.get(spec.threadId);

      if (loaded && (spec.sandboxProfile || loaded.sandboxProfile)) {
        const profile = yield* codexSandboxProfile(ctx, spec);
        yield* assertWarmSandbox(spec, loaded, profile);

        return loaded.codexId;
      }

      const { params, profile } = yield* prepareThread(ctx, spec, "create");

      const response = fork
        ? yield* codex
            .request("thread/fork", {
              threadId: fork.sourceProviderThreadId,
              ...(fork.afterProviderTurnRef && { lastTurnId: fork.afterProviderTurnRef }),
              ...params,
            })
            .pipe(Effect.mapError(fail(spec.threadId, "fork")))
        : yield* startThread(ctx, spec, params, "create");

      yield* verifySandboxResponse(ctx, spec, profile, response);

      if (fork) yield* resumeInstructions(ctx, spec, response.thread.id, params.developerInstructions);
      const entry = register(spec.threadId, response.thread.id, response.thread.path, profile);
      yield* announceThread(ctx, entry).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry.codexId;
    }),
  };
}
