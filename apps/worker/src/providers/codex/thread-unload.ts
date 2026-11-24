import type { ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import { unsubscribeThread } from "./thread-path.ts";
import { threadEvents } from "./thread-events.ts";
import { fail, type CodexThreadContext, type CodexThreadError, type Entry } from "./thread-types.ts";

/** Native archive shuts down the session; cold admission restores its durable rollout. */
export function unloadCodexThread(ctx: CodexThreadContext, threadId: string) {
  return Effect.gen(function* () {
    const entry = ctx.byPlatform.get(threadId);
    const failures: CodexThreadError[] = [];

    const attempt = <A>(effect: Effect.Effect<A, CodexThreadError>) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error);
          }),
        ),
      );

    const native = <A>(effect: Effect.Effect<A, CodexThreadError>) =>
      Effect.suspend((): Effect.Effect<A | void, CodexThreadError> => (ctx.failure ? Effect.void : effect)).pipe(
        attempt,
      );

    if (entry && !ctx.failure) {
      const goal = yield* ctx.codex
        .request("thread/goal/get", { threadId: entry.codexId })
        .pipe(Effect.mapError(fail(threadId, "unload goal")), native);

      if (goal?.goal?.status === "active")
        yield* ctx.codex
          .request("thread/goal/set", { threadId: entry.codexId, origin: "user", status: "paused" })
          .pipe(Effect.mapError(fail(threadId, "unload goal")), native);

      for (const codexTurn of entry.codexToPlatform.keys()) {
        if (entry.finishedTurns.has(codexTurn)) continue;
        entry.interrupting.add(codexTurn);
        yield* ctx.codex
          .request("turn/interrupt", { threadId: entry.codexId, turnId: codexTurn })
          .pipe(Effect.mapError(fail(threadId, "unload interrupt")), native);
      }

      // Native cleanup includes terminals whose notifications are still in flight.
      yield* ctx.codex
        .request("thread/backgroundTerminals/clean", { threadId: entry.codexId })
        .pipe(Effect.mapError(fail(threadId, "unload tasks")), native);

      const release = entry.privateRollout
        ? unsubscribeThread(ctx, entry)
        : ctx.codex
            .request("thread/archive", { threadId: entry.codexId })
            .pipe(Effect.mapError(fail(threadId, "unload")));

      const released = yield* release.pipe(Effect.as(true), native);

      // Finish any notification already being journaled before dropping its registry entry.
      yield* threadEvents(ctx).record(entry).pipe(Effect.ignore);

      if (released) {
        ctx.byCodex.delete(entry.codexId);
        ctx.byPlatform.delete(threadId);
      }
    }

    // The crashed process owns no native work anymore. Release local transports without RPCs;
    // the host settles journal orphans, including turns whose final notifications were lost.
    if (ctx.failure) {
      if (entry) ctx.byCodex.delete(entry.codexId);
      ctx.byPlatform.delete(threadId);
      failures.length = 0;
    }

    yield* Effect.tryPromise({
      try: () => ctx.connectorMcp?.unload(threadId) ?? Promise.resolve(),
      catch: (cause) => fail(threadId, "unload MCP")({ message: String(cause) }),
    }).pipe(attempt);
    ctx.mcpSpecs.delete(threadId);

    if (failures[0]) return yield* failures[0];
  });
}

/** Release only the idle session moving to another checkout. Archive forces a cold native resume. */
export function releaseCodexPlacement(ctx: CodexThreadContext, spec: ThreadSpec, entry: Entry) {
  return Effect.gen(function* () {
    const blocked = (message: string) => fail(spec.threadId, "switch worktree")({ message });

    if (spec.sandboxProfile || entry.sandboxProfile || entry.sandboxProfileInvalid)
      return yield* blocked("Threads using a custom sandbox profile must stay in their assigned directory.");

    if (spec.providerThreadId !== entry.codexId)
      return yield* blocked("The Codex session changed before the worktree switch.");

    if (
      entry.pendingTurns.length ||
      entry.mapper.backgroundTasks.length ||
      [...entry.codexToPlatform.keys()].some((id) => !entry.finishedTurns.has(id))
    )
      return yield* blocked("Wait for the previous worktree’s turns and background tasks to finish.");

    if (entry.privateRollout) yield* unsubscribeThread(ctx, entry);
    else
      yield* ctx.codex
        .request("thread/archive", { threadId: entry.codexId })
        .pipe(Effect.mapError(fail(spec.threadId, "switch worktree")));

    yield* threadEvents(ctx).record(entry);
    ctx.byPlatform.delete(spec.threadId);
    ctx.byCodex.delete(entry.codexId);
  });
}
