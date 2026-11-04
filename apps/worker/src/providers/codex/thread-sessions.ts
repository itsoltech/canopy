import type { ForkSpec, ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import { codexThreadProvider } from "./launch.ts";
import { codexPermissions } from "./permissions.ts";

import { CodexThreadError, fail, type Entry, type CodexThreadContext } from "./thread-types.ts";
import { registerThread } from "./thread-registry.ts";
import { dynamicTools } from "./dynamic-tools.ts";

const NO_ROLLOUT = /no rollout found/i;

export function threadSessions(ctx: CodexThreadContext) {
  const { options, codex, journal, byPlatform, connectorCatalog } = ctx;

  const register = (platformId: string, codexId: string, rolloutPath: string | null) =>
    registerThread(ctx, platformId, codexId, rolloutPath);

  const threadParams = (spec: ThreadSpec) => {
    connectorCatalog.set(spec.threadId, spec.connectorTools);
    const profile = options.profile(spec.providerProfileId);

    if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);

    return {
      cwd: spec.cwd,
      ...(spec.model && { model: spec.model }),
      ...(spec.instructions && { developerInstructions: spec.instructions }),
      ...codexPermissions(spec.permissionMode),
      ...codexThreadProvider(profile),
    };
  };

  const announce = (entry: Entry, replaces = "") =>
    journal
      .append(entry.platformId, {
        body: {
          case: "threadReady",
          value: { providerThreadId: entry.codexId, ...(replaces && { replacesProviderThreadId: replaces }) },
        },
      })
      .pipe(Effect.tap((event) => Effect.sync(() => options.publish(event))));

  const startThread = (spec: ThreadSpec, params: ReturnType<typeof threadParams>, operation: string) =>
    codex
      .request("thread/start", { ...params, ...dynamicTools(spec, options.viewImage !== undefined) })
      .pipe(Effect.mapError(fail(spec.threadId, operation)));

  const ensureLoaded = (spec: ThreadSpec) =>
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

      const resumed = yield* codex.request("thread/resume", { threadId: spec.providerThreadId, ...params }).pipe(
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
      const started = yield* startThread(spec, params, "resume");
      const entry = register(spec.threadId, started.thread.id, started.thread.path);
      yield* announce(entry, spec.providerThreadId).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry;
    });

  return {
    ensureLoaded,
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
      yield* announce(entry).pipe(Effect.mapError(fail(spec.threadId, "journal")));

      return entry.codexId;
    }),
  };
}
