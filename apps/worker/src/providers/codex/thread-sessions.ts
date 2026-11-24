import type { v2 } from "@canopy/codex-protocol";
import type { ForkSpec, ThreadSpec, RewindThread } from "@canopy/contracts";
import { Effect, Semaphore } from "effect";
import { threadParams as paramsOf } from "./thread-params.ts";

import { CodexThreadError, fail, type Entry, type CodexThreadContext } from "./thread-types.ts";
import { releaseCodexPlacement } from "./thread-unload.ts";
import { registerThread } from "./thread-registry.ts";
import { dynamicTools } from "./dynamic-tools.ts";
import { assertWarmSandbox, codexSandboxProfile, verifySandboxResponse } from "./sandbox-profile.ts";
import { importedPath, noRollout, previousRollout, rememberCliHome, unsubscribeThread } from "./thread-path.ts";

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
    yield* unsubscribeThread(ctx, entry);

    const resumed = yield* resumeThread(
      ctx,
      spec,
      entry.codexId,
      { ...params, ...resumeFromPath(params, entry.privateRollout), excludeTurns: true },
      "connectors",
    );

    if (resumed) {
      yield* verifySandboxResponse(ctx, spec, profile, resumed);

      return entry;
    }

    yield* requireEmptyRollout(ctx, spec, entry.codexId);

    // An empty session has no rollout until its first turn.
    const started = yield* startThread(ctx, spec, params, "connectors");
    yield* verifySandboxResponse(ctx, spec, profile, started);
    ctx.byCodex.delete(entry.codexId);
    const replacement = registerThread(ctx, spec, started.thread.id, started.thread.path, profile);
    yield* announceThread(ctx, replacement, entry.codexId).pipe(Effect.mapError(fail(spec.threadId, "journal")));

    return replacement;
  });
}

/** Codex may replace an empty thread after restart, but a completed turn or a workspace switch proves it had history. */
function requireEmptyRollout(ctx: CodexThreadContext, spec: ThreadSpec, id: string, moved = false) {
  return Effect.gen(function* () {
    const used = yield* ctx.journal
      .hasCodexSessionHistory(spec.threadId, id)
      .pipe(Effect.mapError(fail(spec.threadId, "journal")));

    if (moved || used)
      return yield* new CodexThreadError({
        threadId: spec.threadId,
        operation: "resume",
        message: "Codex could not find this thread’s session history. Restore its rollout before continuing.",
      });
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
    .pipe(
      Effect.mapError(fail(spec.threadId, operation)),
      Effect.tap(({ thread }) => rememberCliHome(ctx, spec, thread.id)),
    );
}

function resumeFromPath(params: ReturnType<typeof paramsOf>, path: string | undefined) {
  return path ? { path, config: { ...params.config, thread_unload_delay_secs: 0 } } : {};
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
        !params.path && noRollout.test(error.message)
          ? Effect.succeed(undefined)
          : Effect.fail(fail(spec.threadId, operation)(error)),
      ),
    );
}

function forkThread(
  ctx: CodexThreadContext,
  spec: ThreadSpec,
  params: v2.ThreadForkParams & { modelProvider: string },
  operation: "fork" | "rewind",
) {
  return Effect.gen(function* () {
    const path = yield* previousRollout(ctx, spec, params.threadId, params.modelProvider);
    const fork = ctx.codex.request("thread/fork", { ...params, ...(path && { path }) });

    return yield* fork.pipe(
      Effect.catch((error) => {
        if (path || error.code !== -32600 || !error.message.includes(`session ${params.threadId} is archived.`))
          return Effect.fail(error);

        // Another fork or a cold resume may restore the rollout before unarchive runs.
        return ctx.codex
          .request("thread/unarchive", { threadId: params.threadId })
          .pipe(Effect.ignore, Effect.andThen(fork));
      }),
      Effect.mapError(fail(spec.threadId, operation)),
      Effect.tap(({ thread }) => rememberCliHome(ctx, spec, thread.id)),
    );
  });
}

function resumeStoredThread(
  ctx: CodexThreadContext,
  spec: ThreadSpec,
  params: ReturnType<typeof paramsOf>,
  profile: Entry["sandboxProfile"],
) {
  return Effect.gen(function* () {
    // Archive shuts down the native session and moves its rollout. Restore its original path
    // before imported-session repair or cold resume; this does not load a native session.
    const privatePath = yield* previousRollout(ctx, spec, spec.providerThreadId, params.modelProvider);

    if (!privatePath)
      yield* ctx.codex.request("thread/unarchive", { threadId: spec.providerThreadId }).pipe(Effect.ignore);

    const imported = ctx.options.previousPrivateHome ? undefined : yield* importedPath(ctx, spec, params.modelProvider);

    const resumed = yield* resumeThread(ctx, spec, spec.providerThreadId, {
      ...params,
      ...(imported && { path: imported }),
      ...resumeFromPath(params, privatePath),
    });

    if (resumed) {
      yield* verifySandboxResponse(ctx, spec, profile, resumed);
      yield* resumeInstructions(ctx, spec, resumed.thread.id, params.developerInstructions);

      const entry = registerThread(ctx, spec, resumed.thread.id, resumed.thread.path, profile);

      if (privatePath) entry.privateRollout = privatePath;

      return entry;
    }

    return undefined;
  });
}

export function threadSessions(ctx: CodexThreadContext) {
  const { codex, byPlatform } = ctx;
  const loading = Semaphore.makeUnsafe(1);

  const register = registerThread.bind(undefined, ctx);

  const ensureLoaded = (spec: ThreadSpec, recoveryContext = "") =>
    Effect.gen(function* () {
      const loaded = byPlatform.get(spec.threadId);

      if (loaded && loaded.cwd !== spec.cwd) yield* releaseCodexPlacement(ctx, spec, loaded);
      else if (loaded) {
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

      const resumed = yield* resumeStoredThread(ctx, spec, params, profile);

      if (resumed) return resumed;

      yield* requireEmptyRollout(ctx, spec, spec.providerThreadId, Boolean(loaded));

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
      const entry = register(spec, started.thread.id, started.thread.path, profile);
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
        yield* unsubscribeThread(ctx, previous);
        ctx.byCodex.delete(previous.codexId);
        byPlatform.delete(spec.threadId);
      }

      if (request.restoreProviderThreadId) {
        const privatePath = yield* previousRollout(ctx, spec, request.restoreProviderThreadId, params.modelProvider);

        const response = yield* codex
          .request("thread/resume", {
            threadId: request.restoreProviderThreadId,
            ...params,
            ...resumeFromPath(params, privatePath),
          })
          .pipe(Effect.mapError(fail(spec.threadId, "restore rewind")));

        yield* verifySandboxResponse(ctx, spec, profile, response);
        yield* resumeInstructions(ctx, spec, response.thread.id, params.developerInstructions);
        const entry = register(spec, response.thread.id, response.thread.path, profile);

        if (privatePath) entry.privateRollout = privatePath;

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
        : yield* forkThread(
            ctx,
            spec,
            { ...params, threadId: request.sourceProviderThreadId, lastTurnId: request.afterProviderTurnRef },
            "rewind",
          );

      yield* verifySandboxResponse(ctx, spec, profile, response);

      if (!request.empty) yield* resumeInstructions(ctx, spec, response.thread.id, params.developerInstructions);
      register(spec, response.thread.id, response.thread.path, profile);

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
        ? yield* forkThread(
            ctx,
            spec,
            {
              threadId: fork.sourceProviderThreadId,
              ...(fork.afterProviderTurnRef && { lastTurnId: fork.afterProviderTurnRef }),
              ...params,
            },
            "fork",
          )
        : yield* startThread(ctx, spec, params, "create");

      yield* verifySandboxResponse(ctx, spec, profile, response);

      if (fork) yield* resumeInstructions(ctx, spec, response.thread.id, params.developerInstructions);
      const entry = register(spec, response.thread.id, response.thread.path, profile);
      yield* announceThread(ctx, entry).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry.codexId;
    }),
  };
}
