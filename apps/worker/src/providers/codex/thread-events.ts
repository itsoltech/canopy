import type { ServerNotification } from "@canopy/codex-protocol";
import { TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { Effect } from "effect";
import { Journal } from "../../journal/index.ts";
import { reconcileTurn } from "../reconcile.ts";

import type { Entry, CodexThreadContext } from "./thread-types.ts";
import { withUserMentions } from "./thread-registry.ts";
import { warnLateEvent } from "./late-events.ts";

export function threadEvents(ctx: CodexThreadContext) {
  const { options, journal } = ctx;

  /** New rollout items of turns started in this process, as the notification the mapper reads. */
  const rolloutItems = (entry: Entry): ServerNotification[] => {
    const rollout = entry.rollout;

    if (!rollout) return [];
    const items: ServerNotification[] = [];

    for (const line of rollout.tail.read()) {
      if (line.kind === "turn") {
        // Turns of other processes (forked or resumed history) are skipped.
        rollout.turn = !line.ended && entry.codexToPlatform.has(line.turnId) ? line.turnId : undefined;

        if (line.ended) rollout.ended.add(line.turnId);
      } else if (rollout.turn) {
        items.push({
          method: "rawResponseItem/completed",
          params: { threadId: entry.codexId, turnId: rollout.turn, item: line.item },
        });
      }
    }

    return items;
  };

  /** Read on item notifications; before turn/completed, until the turn's end is in the file (written asynchronously). */
  const fromRollout = (entry: Entry, notification: ServerNotification) =>
    Effect.gen(function* () {
      if (notification.method === "item/started" || notification.method === "item/completed")
        return rolloutItems(entry);

      if (notification.method !== "turn/completed" || !entry.rollout) return [];
      const turnId = notification.params.turn.id;
      const items = rolloutItems(entry);

      for (let attempt = 0; !entry.rollout.ended.delete(turnId) && attempt < 40; attempt++) {
        yield* Effect.sleep("25 millis");
        items.push(...rolloutItems(entry));
      }

      return items;
    });

  const recordNotification = (entry: Entry, notification: ServerNotification) =>
    Effect.gen(function* () {
      warnLateEvent(ctx, entry, notification);

      // Stop/steer can race rollout reconciliation and journal enrichment. The provider has already ended.
      if (notification.method === "turn/completed") entry.finishedTurns.add(notification.params.turn.id);
      const notifications = [...(yield* fromRollout(entry, notification)), notification];

      const inits = notifications.flatMap((n) => entry.mapper.map(n));

      // Where Codex records this turn: read to settle it if its end never arrives (worker restart, crash).
      if (notification.method === "turn/started" && entry.rolloutPath) {
        const codexTurn = notification.params.turn.id;
        const turnId = entry.codexToPlatform.get(codexTurn);

        if (turnId) {
          yield* journal
            .noteHarness(entry.platformId, turnId, {
              harness: "codex",
              transcript: entry.rolloutPath,
              sessionId: entry.codexId,
              offset: 0,
              providerTurn: codexTurn,
            })
            .pipe(Effect.ignore);
        }
      }

      return yield* Effect.forEach(
        inits.map((init) => withUserMentions(init, entry.mentions)),
        (init) =>
          (options.enrich ? Effect.promise(() => options.enrich!(init)) : Effect.succeed(init)).pipe(
            Effect.flatMap((enriched) => journal.append(entry.platformId, enriched)),
            Effect.tap((event) => Effect.sync(() => options.publish(event))),
          ),
      );
    });

  // A provider wake-up may precede the notification for a requested turn. Only the RPC response
  // identifies the requested turn; preserve notification order until that binding is known.
  const record = (entry: Entry, notification?: ServerNotification) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        entry.recordingNotifications = true;
      }),
      () =>
        Effect.gen(function* () {
          if (notification) entry.pendingNotifications.push(notification);

          if (entry.pendingTurns.length > 0) return [];
          const pending = entry.pendingNotifications.splice(0);

          const recorded = yield* Effect.forEach(pending, (next) =>
            recordNotification(entry, next).pipe(Effect.orElseSucceed(() => [])),
          );

          return recorded.flat();
        }),
      () =>
        Effect.sync(() => {
          entry.recordingNotifications = false;

          if (!notification) options.onActivitySettled?.();
        }),
    ).pipe(entry.recording.withPermit);

  return { record };
}

export function threadExit(ctx: CodexThreadContext) {
  const { options, journal, codex, byPlatform } = ctx;

  /**
   * The app-server exited on its own: every turn it ran ends the way its rollout says, else as failed in the
   * harness (its process is gone). Background processes died with it (the host closes them when it restarts
   * the runtime).
   */
  const settleAfterExit = (code: number | null) =>
    Effect.gen(function* () {
      // The last line that says what went wrong (warnings are noise here).
      const stderr = codex
        .stderrTail()
        .split("\n")
        .filter((line) => /error|panic|fatal/i.test(line))
        .at(-1)
        ?.slice(0, 500);

      ctx.failure = `codex app-server exited (code ${code ?? "?"})${stderr ? `: ${stderr}` : ""}`;
      const running = new Set<string>();

      for (const entry of byPlatform.values()) {
        for (const [codexTurn, turnId] of entry.codexToPlatform)
          if (!entry.finishedTurns.has(codexTurn)) running.add(`${entry.platformId}/${turnId}`);
      }

      const open = (yield* journal.openTurns()).filter((t) => running.has(`${t.threadId}/${t.turnId}`));

      for (const turn of open) {
        const { events } = yield* reconcileTurn(turn, {
          outcome: TurnOutcome.FAILED,
          source: TurnEndSource.HARNESS,
          reason: `harness process exited (code ${code ?? "?"})${stderr ? `: ${stderr}` : ""}`,
          errorCode: "process_exit",
        }).pipe(Effect.provideService(Journal, journal));

        for (const event of events) options.publish(event);
      }

      for (const entry of byPlatform.values())
        for (const codexTurn of entry.codexToPlatform.keys()) entry.finishedTurns.add(codexTurn);
    });

  return settleAfterExit;
}
