import { type ThreadEvent } from "@canopy/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { ENDED, applySideEffects, applySteer, insertEvent, resolveTurn } from "./ingest-events.ts";
import { settleThread, stuckThread } from "./ingest-settle.ts";
import { applyShellInput } from "./shell-input.ts";
import { storageEvent } from "./event-text.ts";
import { dataErrorCode, quarantineEvent } from "./event-quarantine.ts";
import { queryFamily, queryMethods } from "../diagnostics/query-context.ts";
import { acknowledgeEvents, archivedEventAllowed, type IngestFallback, type IngestOutcome } from "./ingest-outcomes.ts";

/**
 * Writes worker events into the thread timeline (docs/transcript.md, "Zapis po stronie gateway").
 *
 * Per thread, in one transaction: lock the thread, drop events whose event_id is already stored,
 * assign seq, insert thread_events, apply side effects (provider thread id, turns, thread status,
 * item projection with the shared reducer) and remember the worker's journal cursor.
 * The caller acks the worker only after this commits.
 *
 * Background tasks (docs/execution.md, "Pobudka"): their items get the event's time as start and end when the worker
 * did not stamp them, and every end writes the note the agent gets (background_task_notes, once per task).
 *
 * settle() is the safety net behind every turn end (docs/durability.md, "Stany tury i wątku"): whatever the worker
 * reported, nothing of a finished turn stays open. It writes its fixes as gateway events (origin = gateway, the
 * audit reason in raw), so the UI applies them like any event.
 */

export { turnEnd } from "./ingest-events.ts";

export interface StoredEvent {
  readonly threadId: string;
  readonly seq: bigint;
  readonly event: ThreadEvent;
}

export interface IngestResult {
  /** Highest journal_seq per thread that is now persisted (duplicates included): EventAck. */
  readonly acks: ReadonlyMap<string, bigint>;
  /** Newly stored events, in timeline order, for live subscribers. */
  readonly stored: readonly StoredEvent[];
  readonly outcomes: readonly IngestOutcome[];
  /** Threads the gateway does not know: not acked, the worker keeps them. */
  readonly unknownThreads: readonly string[];
  /** Threads whose events could not be stored this time: not acked; retried independently of the link. */
  readonly failedThreads: readonly { threadId: string; error: SqlError.SqlError }[];
}

export interface SettleResult {
  /** Gateway events that closed items, in timeline order. */
  readonly stored: readonly StoredEvent[];
  /** The thread's status changed (back to idle). */
  readonly threadChanged: boolean;
}

export const ingestThread = (
  sql: SqlClient.SqlClient,
  workerId: string,
  journalId: string,
  threadId: string,
  events: readonly ThreadEvent[],
  origin: "worker" | "gateway" = "worker",
  fallback?: IngestFallback,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const locked = yield* sql<{
        last_seq: string;
        archived_at: Date | null;
        deleted_at: Date | null;
        worker_id: string | null;
        rewind_pending_id: string | null;
      }>`SELECT last_seq, archived_at, deleted_at, worker_id,rewind_pending_id FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;

      const thread = locked[0];

      if (!thread || thread.worker_id !== workerId) return undefined;
      const outcomes: IngestOutcome[] = [];

      if (thread.deleted_at) {
        const previous = yield* sql<{ acked_seq: string }>`SELECT acked_seq FROM worker_journal_cursors
          WHERE worker_id=${workerId}::uuid AND journal_id=${journalId} AND thread_id=${threadId}::uuid`;

        const count = events.filter((e) => e.journalSeq > BigInt(previous[0]?.acked_seq ?? 0)).length;
        const ack = yield* acknowledgeEvents(sql, workerId, journalId, threadId, events);

        if (count) outcomes.push({ threadId, kind: "dropped", reason: "deleted_thread", count });

        return { ack, stored: [], outcomes };
      }

      let last = BigInt(thread.last_seq);
      const ids = events.map((e) => e.eventId);

      const known = new Set(
        (yield* sql<{
          event_id: string;
        }>`SELECT event_id FROM thread_events WHERE thread_id = ${threadId}::uuid AND event_id = ANY(${ids}::uuid[])`).map(
          (r) => r.event_id,
        ),
      );

      const stored: StoredEvent[] = [];

      const superseded = new Set(
        (yield* sql<{ id: string }>`SELECT id FROM turns
        WHERE thread_id=${threadId}::uuid AND rewind_id IS NOT NULL`).map((row) => row.id),
      );

      for (const incoming of events) {
        if (known.has(incoming.eventId)) continue;
        known.add(incoming.eventId);
        const seq = ++last;

        const content =
          incoming.body.case === "itemStarted" || incoming.body.case === "itemCompleted"
            ? incoming.body.value.item?.content
            : undefined;

        const gatewayGallery =
          origin === "worker" &&
          ((content?.case === "agentMessage" &&
            (content.value.images.length > 0 || Boolean(content.value.imageError))) ||
            ((incoming.body.case === "itemStarted" || incoming.body.case === "itemCompleted") &&
              incoming.body.value.item?.content.case === "imageGallery") ||
            ((incoming.body.case === "itemStarted" || incoming.body.case === "itemCompleted") &&
              incoming.body.value.item?.itemId.startsWith("gallery-")) ||
            (incoming.body.case === "itemDelta" && incoming.body.value.itemId.startsWith("gallery-")));

        const rejection = gatewayGallery
          ? { code: "23514", reason: "data_error" as const }
          : thread.archived_at && !(yield* archivedEventAllowed(sql, incoming))
            ? { code: "23514", reason: "archived_thread" as const }
            : fallback;

        const suppressed =
          superseded.has(incoming.turnId) ||
          Boolean(
            thread.rewind_pending_id &&
            (incoming.body.case === "turnStarted" ||
              incoming.body.case === "threadReady" ||
              incoming.body.case === "goalState"),
          );

        const event = rejection
          ? yield* quarantineEvent(sql, workerId, journalId, incoming, rejection.code, rejection.reason)
          : yield* resolveTurn(sql, threadId, storageEvent(incoming), !suppressed);

        yield* insertEvent(sql, threadId, seq, event, rejection ? "gateway" : origin);

        if (!suppressed) {
          yield* applySideEffects(sql, threadId, seq, event);
          yield* applySteer(sql, threadId, seq, event);
        }

        if (!suppressed && event.body.case === "shellInputPrepared")
          yield* applyShellInput(sql, threadId, event.body.value);
        stored.push({ threadId, seq, event });

        if (rejection) outcomes.push({ threadId, kind: "quarantined", reason: rejection.reason, count: 1 });
      }

      yield* sql`UPDATE threads SET last_seq = ${last} WHERE id = ${threadId}::uuid`;
      const ack = yield* acknowledgeEvents(sql, workerId, journalId, threadId, events);

      return { ack, stored, outcomes };
    }),
  );

export class Ingest extends Context.Service<
  Ingest,
  {
    ingest(
      workerId: string,
      journalId: string,
      events: readonly ThreadEvent[],
      fallback?: IngestFallback,
    ): Effect.Effect<IngestResult, SqlError.SqlError>;
    /**
     * Closes what a finished turn left open (docs/durability.md, "Stany tury i wątku"): items still in progress in a
     * finished turn (or outside any turn while none runs) end as interrupted, except background tasks and the
     * commands they continue; the thread goes back to idle when nothing runs (a running or waiting thread without a
     * running turn, an interrupted one, a failed one that has a provider thread). `staleSeconds` (sweep): only a
     * thread unchanged that long counts as running without a turn (a turn_started may still be on its way).
     */
    settle(
      threadId: string,
      reason: string,
      options?: { staleSeconds?: number },
    ): Effect.Effect<SettleResult, SqlError.SqlError>;
    /** Threads settle() would change (the sweep). */
    unsettledThreads(staleSeconds: number): Effect.Effect<readonly string[], SqlError.SqlError>;
  }
>()("canopy/gateway/Ingest") {
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return Ingest.of(
        queryMethods("ingest.events", {
          settle: Effect.fn("Ingest.settle")((threadId: string, reason: string, options?: { staleSeconds?: number }) =>
            settleThread(sql, threadId, reason, options?.staleSeconds ?? 0),
          ),
          unsettledThreads: Effect.fn("Ingest.unsettledThreads")(function* (staleSeconds: number) {
            const rows = yield* sql<{ id: string }>`
      SELECT t.id FROM threads t
       WHERE t.archived_at IS NULL AND (
         ${stuckThread(sql, staleSeconds)}
         OR EXISTS (SELECT 1 FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
                     WHERE i.thread_id = t.id AND i.status = 'in_progress' AND i.type NOT IN ('background_task', 'interaction_prompt')
                       AND (u.status = ANY(${ENDED}::text[])
                            OR (i.turn_id IS NULL AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')))
                       AND NOT EXISTS (SELECT 1 FROM thread_items b
                                        WHERE b.thread_id = i.thread_id AND b.type = 'background_task' AND b.status = 'in_progress'
                                          AND b.content->'backgroundTask'->>'sourceItemId' = i.item_id))
         OR EXISTS (SELECT 1 FROM turn_steers s JOIN turns u ON u.id = s.turn_id
                     WHERE s.thread_id = t.id AND s.status IN ('pending', 'accepted', 'dropped') AND u.status = ANY(${ENDED}::text[]))
         OR EXISTS (SELECT 1 FROM interaction_requests q JOIN turns u ON u.id = q.turn_id
                     WHERE q.thread_id = t.id AND q.status = 'pending' AND q.question_call_id IS NULL AND u.status = ANY(${ENDED}::text[])))
       ORDER BY t.id`;

            return rows.map((r) => r.id);
          }),
          ingest: Effect.fn("Ingest.ingest")(function* (
            workerId: string,
            journalId: string,
            events: readonly ThreadEvent[],
            fallback?: IngestFallback,
          ) {
            const byThread = new Map<string, ThreadEvent[]>();

            for (const event of [...events].sort((a, b) =>
              a.journalSeq < b.journalSeq ? -1 : a.journalSeq > b.journalSeq ? 1 : 0,
            )) {
              const group = byThread.get(event.threadId) ?? [];
              group.push(event);
              byThread.set(event.threadId, group);
            }

            const acks = new Map<string, bigint>();
            const stored: StoredEvent[] = [];
            const outcomes: IngestOutcome[] = [];
            const unknownThreads: string[] = [];
            const failedThreads: { threadId: string; error: SqlError.SqlError }[] = [];

            for (const [threadId, threadEvents] of byThread) {
              // Isolate data exceptions; other failures keep the thread unacked for redelivery.
              const result = yield* ingestThread(
                sql,
                workerId,
                journalId,
                threadId,
                threadEvents,
                "worker",
                fallback,
              ).pipe(
                Effect.catchTag("SqlError", (error) =>
                  dataErrorCode(error)
                    ? isolateDataErrors(sql, workerId, journalId, threadId, threadEvents)
                    : Effect.fail(error),
                ),
                Effect.catchTag("SqlError", (error) => Effect.sync(() => void failedThreads.push({ threadId, error }))),
              );

              if (result === undefined && failedThreads.some((f) => f.threadId === threadId)) continue;

              if (!result) {
                unknownThreads.push(threadId);
                continue;
              }

              acks.set(threadId, result.ack);
              stored.push(...result.stored);
              outcomes.push(...result.outcomes);
            }

            return { acks, stored, outcomes, unknownThreads, failedThreads };
          }, queryFamily("ingest.events")),
        }),
      );
    }),
  );
}

/** Slow path only: isolate bad events with savepoints, then commit originals, markers and cursor together. */
const isolateDataErrors = (
  sql: SqlClient.SqlClient,
  workerId: string,
  journalId: string,
  threadId: string,
  events: readonly ThreadEvent[],
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const stored: StoredEvent[] = [];
      const outcomes: IngestOutcome[] = [];
      let ack = 0n;

      for (const event of events) {
        const result = yield* ingestThread(sql, workerId, journalId, threadId, [event]).pipe(
          Effect.catchTag("SqlError", (error) => {
            const code = dataErrorCode(error);

            if (!code) return Effect.fail(error);

            return Effect.gen(function* () {
              const saved = yield* ingestThread(sql, workerId, journalId, threadId, [event], "worker", {
                code,
                reason: "data_error",
              });

              yield* sql.afterCommit(
                Effect.logWarning("Worker event quarantined", {
                  workerId,
                  threadId,
                  eventId: event.eventId,
                  journalSeq: String(event.journalSeq),
                  sqlstate: code,
                }),
              );

              return saved;
            });
          }),
        );

        if (!result) return undefined;

        if (result.ack > ack) ack = result.ack;
        stored.push(...result.stored);
        outcomes.push(...result.outcomes);
      }

      return { ack, stored, outcomes };
    }),
  );
