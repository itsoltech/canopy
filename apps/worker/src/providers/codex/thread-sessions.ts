import type { ForkSpec, ThreadSpec } from "@canopy/contracts";
import { Effect, Semaphore } from "effect";
import { codexThreadProvider } from "./launch.ts";
import { codexPermissions } from "./permissions.ts";

import { CodexThreadError, fail, type Entry, type CodexThreadContext } from "./thread-types.ts";
import { registerThread } from "./thread-registry.ts";
import { dynamicTools } from "./dynamic-tools.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";

const NO_ROLLOUT = /no rollout found/i;

const announceThread = (ctx: CodexThreadContext, entry: Entry, replaces = "") =>
  ctx.journal
    .append(entry.platformId, {
      body: {
        case: "threadReady",
        value: { providerThreadId: entry.codexId, ...(replaces && { replacesProviderThreadId: replaces }) },
      },
    })
    .pipe(Effect.tap((event) => Effect.sync(() => ctx.options.publish(event))));

export function threadSessions(ctx: CodexThreadContext) {
  const { options, codex, byPlatform, connectorCatalog } = ctx;
  const loading = Semaphore.makeUnsafe(1);

  const register = (platformId: string, codexId: string, rolloutPath: string | null) =>
    registerThread(ctx, platformId, codexId, rolloutPath);

  const threadParams = (spec: ThreadSpec) => {
    const home = options.launch.env["CODEX_HOME"];

    if (home) managedPlugins(home, "codex");
    connectorCatalog.set(spec.threadId, spec.connectorTools);
    const profile = options.profile(spec.providerProfileId);

    if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);

    return {
      cwd: spec.cwd,
      // No project root search in scratch: otherwise Codex can collect ~/AGENTS.md on its parent walk.
      config: {
        ...(spec.scratch && { project_root_markers: [] }),
        ...ctx.connectorMcp?.config(spec),
      },
      ...(spec.model && { model: spec.model }),
      ...(spec.instructions && { developerInstructions: spec.instructions }),
      ...codexPermissions(spec.permissionMode),
      ...codexThreadProvider(profile),
    };
  };

  const startThread = (spec: ThreadSpec, params: ReturnType<typeof threadParams>, operation: string) =>
    codex
      .request("thread/start", { ...params, ...dynamicTools(spec, options.viewImage !== undefined) })
      .pipe(Effect.mapError(fail(spec.threadId, operation)));

  const ensureLoaded = (spec: ThreadSpec, recoveryContext = "") =>
    Effect.gen(function* () {
      const loaded = byPlatform.get(spec.threadId);

      if (loaded) return loaded;

      if (!spec.providerThreadId) {
        return yield* new CodexThreadError({
          threadId: spec.threadId,
          operation: "resume",
          message: "thread was never created on Codex",
        });
      }

      const params = yield* Effect.try({
        try: () => threadParams(spec),
        catch: (cause) => fail(spec.threadId, "resume")(cause instanceof Error ? cause : new Error(String(cause))),
      });

      const path = yield* Effect.try({
        try: () => options.importedResumePath?.(spec, params.modelProvider),
        catch: (cause) => fail(spec.threadId, "resume")(cause instanceof Error ? cause : new Error(String(cause))),
      });

      const resumed = yield* codex
        .request("thread/resume", { threadId: spec.providerThreadId, ...params, ...(path && { path }) })
        .pipe(
          Effect.map((response) => response.thread),
          Effect.catch((error) =>
            NO_ROLLOUT.test(error.message)
              ? Effect.succeed(undefined)
              : Effect.fail(fail(spec.threadId, "resume")(error)),
          ),
        );

      if (resumed) return register(spec.threadId, resumed.id, resumed.path);

      // Codex writes a thread's rollout with its first turn: a thread that never had one is gone with the
      // process that created it. Nothing is lost by starting it again; the gateway keeps the platform
      // thread and takes the new Codex id (thread_ready replaces the old one).
      const started = yield* startThread(
        spec,
        { ...params, developerInstructions: [spec.instructions, recoveryContext].filter(Boolean).join("\n\n") },
        "resume",
      );

      const entry = register(spec.threadId, started.thread.id, started.thread.path);
      yield* announceThread(ctx, entry, spec.providerThreadId).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry;
    }).pipe(loading.withPermit);

  return {
    ensureLoaded,
    reconfigure: (spec: ThreadSpec, entry: Entry) =>
      Effect.gen(function* () {
        if (entry.pendingTurns.length || [...entry.codexToPlatform.keys()].some((id) => !entry.finishedTurns.has(id)))
          return yield* new CodexThreadError({
            threadId: spec.threadId,
            operation: "connectors",
            message: "A turn is still running",
          });
        // 0.164 rejoins subscribed sessions and ignores overrides. Unsubscribe first: an idle
        // session with config overrides is then rebuilt from its durable history, retaining its ID.
        yield* codex
          .request("thread/unsubscribe", { threadId: entry.codexId })
          .pipe(Effect.mapError(fail(spec.threadId, "connectors")));
        const params = threadParams(spec);

        return yield* codex.request("thread/resume", { threadId: entry.codexId, ...params, excludeTurns: true }).pipe(
          Effect.as(entry),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!NO_ROLLOUT.test(error.message)) return yield* fail(spec.threadId, "connectors")(error);
              // An empty session has no rollout until its first turn. Recreate only that empty session.
              const started = yield* startThread(spec, params, "connectors");
              const replacement = register(spec.threadId, started.thread.id, started.thread.path);
              yield* announceThread(ctx, replacement, entry.codexId).pipe(
                Effect.mapError(fail(spec.threadId, "journal")),
              );

              return replacement;
            }),
          ),
        );
      }),
    create: Effect.fn("CodexThreads.create")(function* (spec: ThreadSpec, fork?: ForkSpec) {
      const params = yield* Effect.try({
        try: () => threadParams(spec),
        catch: (cause) => fail(spec.threadId, "create")(cause instanceof Error ? cause : new Error(String(cause))),
      });

      const response = fork
        ? yield* codex
            .request("thread/fork", {
              threadId: fork.sourceProviderThreadId,
              ...(fork.afterProviderTurnRef && { lastTurnId: fork.afterProviderTurnRef }),
              ...params,
            })
            .pipe(Effect.mapError(fail(spec.threadId, "fork")))
        : yield* startThread(spec, params, "create");

      const entry = register(spec.threadId, response.thread.id, response.thread.path);
      yield* announceThread(ctx, entry).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry.codexId;
    }),
  };
}
