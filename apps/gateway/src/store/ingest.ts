import { type ThreadEvent } from "@canopy/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { ENDED, applySideEffects, applySteer, insertEvent, resolveTurn } from "./ingest-events.ts";
import { settleThread, stuckThread } from "./ingest-settle.ts";
import { applyShellInput } from "./shell-input.ts";
import { storageEvent } from "./event-text.ts";
import { dataErrorCode, quarantineEvent } from "./event-quarantine.ts";

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
  /** Threads the gateway does not know: not acked, the worker keeps them. */
  readonly unknownThreads: readonly string[];
  /** Threads whose events could not be stored this time: not acked, resent by the worker after a reconnect. */
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
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const locked = yield* sql<{
        last_seq: string;
      }>`SELECT last_seq FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;

      if (!locked[0]) return undefined;
      let last = BigInt(locked[0].last_seq);
      const ids = events.map((e) => e.eventId);

      const known = new Set(
        (yield* sql<{
          event_id: string;
        }>`SELECT event_id FROM thread_events WHERE thread_id = ${threadId}::uuid AND event_id = ANY(${ids}::uuid[])`).map(
          (r) => r.event_id,
        ),
      );

      const stored: StoredEvent[] = [];

      for (const incoming of events) {
        if (known.has(incoming.eventId)) continue;
        known.add(incoming.eventId);
        const seq = ++last;
        const event = yield* resolveTurn(sql, threadId, storageEvent(incoming));
        yield* insertEvent(sql, threadId, seq, event, origin);
        yield* applySideEffects(sql, threadId, seq, event);
        yield* applySteer(sql, threadId, seq, event);

        if (event.body.case === "shellInputPrepared") yield* applyShellInput(sql, threadId, event.body.value);
        stored.push({ threadId, seq, event });
      }

      yield* sql`UPDATE threads SET last_seq = ${last} WHERE id = ${threadId}::uuid`;
      const ack = events.reduce((max, e) => (e.journalSeq > max ? e.journalSeq : max), 0n);
      yield* sql`
        INSERT INTO worker_journal_cursors (worker_id, journal_id, thread_id, acked_seq)
        VALUES (${workerId}::uuid, ${journalId}, ${threadId}::uuid, ${ack})
        ON CONFLICT (worker_id, journal_id, thread_id) DO UPDATE SET acked_seq = greatest(worker_journal_cursors.acked_seq, EXCLUDED.acked_seq)
      `;

      return { ack, stored };
    }),
  );

export class Ingest extends Context.Service<
  Ingest,
  {
    ingest(
      workerId: string,
      journalId: string,
      events: readonly ThreadEvent[],
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

      return Ingest.of({
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
          const unknownThreads: string[] = [];
          const failedThreads: { threadId: string; error: SqlError.SqlError }[] = [];

          for (const [threadId, threadEvents] of byThread) {
            // Isolate data exceptions; other failures keep the thread unacked for redelivery.
            const result = yield* ingestThread(sql, workerId, journalId, threadId, threadEvents).pipe(
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
          }

          return { acks, stored, unknownThreads, failedThreads };
        }),
      });
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
      let ack = 0n;

      for (const event of events) {
        const result = yield* ingestThread(sql, workerId, journalId, threadId, [event]).pipe(
          Effect.catchTag("SqlError", (error) => {
            const code = dataErrorCode(error);

            if (!code) return Effect.fail(error);

            return Effect.gen(function* () {
              const marker = yield* quarantineEvent(sql, workerId, journalId, event, code);
              const saved = yield* ingestThread(sql, workerId, journalId, threadId, [marker], "gateway");
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
      }

      return { ack, stored };
    }),
  );
