import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  ItemSchema,
  ThreadEventSchema,
  ThreadStatus,
  TurnOutcome,
  UsageSchema,
  type Item,
  type ThreadEvent,
} from "@open-agents/contracts";
import { eventItemId, eventKind, itemStatus, itemType, reduceItem } from "@open-agents/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { applyGoalState } from "./goals.ts";

/**
 * Writes worker events into the thread timeline (docs/transcript.md, "Zapis po stronie gateway").
 *
 * Per thread, in one transaction: lock the thread, drop events whose event_id is already stored,
 * assign seq, insert thread_events, apply side effects (provider thread id, turns, thread status,
 * item projection with the shared reducer) and remember the worker's journal cursor.
 * The caller acks the worker only after this commits.
 */

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

export class Ingest extends Context.Service<
  Ingest,
  {
    ingest(workerId: string, journalId: string, events: readonly ThreadEvent[]): Effect.Effect<IngestResult, SqlError.SqlError>;
  }
>()("open-agents/gateway/Ingest") {
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The provider runs one turn at a time per thread: when it starts another, a turn still marked running
      // here lost its turn_finished (e.g. a provider crash) and is over.
      const supersede = (threadId: string, turnId: string) =>
        sql`
          UPDATE turns SET status = 'interrupted', interrupt_reason = 'superseded: the provider started another turn', completed_at = now()
           WHERE thread_id = ${threadId}::uuid AND status = 'running' AND id <> ${turnId}::uuid
        `;

      const ensureTurn = (threadId: string, turnId: string, trigger: "provider" | "recovery") =>
        Effect.gen(function* () {
          const exists = yield* sql`SELECT 1 FROM turns WHERE id = ${turnId}::uuid`;
          if (exists.length > 0) return;
          yield* supersede(threadId, turnId);
          // A turn the harness starts while a goal is active works for it (e.g. Codex goal continuation).
          yield* sql`
            INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, started_at, goal_id)
            SELECT ${turnId}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'running', ${trigger}, '{}'::jsonb, now(),
                   (SELECT g.id FROM goals g WHERE g.thread_id = ${threadId}::uuid AND g.status = 'active')
              FROM turns WHERE thread_id = ${threadId}::uuid
            ON CONFLICT (id) DO NOTHING
          `;
        });

      /**
       * Turns the provider started itself (e.g. goal continuation) exist from their turn_started on.
       * Any other event naming a turn this thread does not have keeps no turn link: e.g. Codex reports the
       * token usage of the source's last turn right after a fork. Creating a turn from it would leave a
       * turn "running" forever and block the thread's queue.
       */
      const resolveTurn = (threadId: string, event: ThreadEvent) =>
        Effect.gen(function* () {
          if (!event.turnId) return event;
          if (event.body.case === "turnStarted") {
            yield* ensureTurn(threadId, event.turnId, "provider");
            return event;
          }
          const exists = yield* sql`SELECT 1 FROM turns WHERE id = ${event.turnId}::uuid AND thread_id = ${threadId}::uuid`;
          return exists.length > 0 ? event : create(ThreadEventSchema, { ...event, turnId: "" });
        });

      const applyItem = (threadId: string, seq: bigint, event: ThreadEvent) =>
        Effect.gen(function* () {
          const itemId = eventItemId(event.body);
          if (!itemId) return;
          const rows = yield* sql<{ content: JsonValue }>`
            SELECT content FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ${itemId} FOR UPDATE
          `;
          const current: Item | undefined = rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined;
          const next = reduceItem(current, event.body);
          if (!next || next === current) return;
          const content = JSON.stringify(toJson(ItemSchema, next));
          const turnId = event.turnId || null;
          yield* sql`
            INSERT INTO thread_items (thread_id, item_id, turn_id, parent_item_id, type, status, content, first_seq, last_seq)
            VALUES (${threadId}::uuid, ${itemId}, ${turnId}::uuid, ${next.parentItemId || null}, ${itemType(next)}, ${itemStatus(next)},
                    ${content}::jsonb, ${seq}, ${seq})
            ON CONFLICT (thread_id, item_id) DO UPDATE
              SET type = EXCLUDED.type, status = EXCLUDED.status, content = EXCLUDED.content,
                  parent_item_id = EXCLUDED.parent_item_id, last_seq = EXCLUDED.last_seq
          `;
        });

      const applySideEffects = (threadId: string, seq: bigint, event: ThreadEvent) =>
        Effect.gen(function* () {
          const body = event.body;
          switch (body.case) {
            case "threadReady":
              yield* sql`
                UPDATE threads SET provider_thread_id = ${body.value.providerThreadId},
                                   status = CASE WHEN status = 'creating' THEN 'idle' ELSE status END
                 WHERE id = ${threadId}::uuid AND provider_thread_id IS NULL
              `;
              return;
            case "turnStarted":
              yield* supersede(threadId, event.turnId);
              yield* sql`
                UPDATE turns SET status = 'running', started_at = coalesce(started_at, now()),
                                 provider_turn_ref = ${body.value.providerTurnRef || null}, first_seq = coalesce(first_seq, ${seq})
                 WHERE id = ${event.turnId}::uuid AND thread_id = ${threadId}::uuid
              `;
              yield* sql`UPDATE threads SET status = 'running' WHERE id = ${threadId}::uuid AND status <> 'archived'`;
              return;
            case "turnFinished": {
              const status = turnStatus(body.value.outcome);
              yield* sql`
                UPDATE turns SET status = ${status}, last_seq = ${seq}, completed_at = now(),
                                 provider_turn_ref = coalesce(${body.value.providerTurnRef || null}, provider_turn_ref),
                                 usage = ${body.value.usage ? JSON.stringify(toJson(UsageSchema, body.value.usage)) : null}::jsonb,
                                 error = ${status === "failed" ? body.value.reason || null : null},
                                 interrupt_reason = ${status === "interrupted" ? body.value.reason || null : null}
                 WHERE id = ${event.turnId}::uuid AND thread_id = ${threadId}::uuid
              `;
              yield* sql`
                UPDATE threads SET status = ${status === "completed" ? "idle" : status} WHERE id = ${threadId}::uuid AND status <> 'archived'
              `;
              return;
            }
            case "activity": {
              const status = threadStatus(body.value.status);
              if (status) yield* sql`UPDATE threads SET status = ${status} WHERE id = ${threadId}::uuid AND status <> 'archived'`;
              return;
            }
            case "goalState":
              yield* applyGoalState(sql, threadId, event.turnId, body.value);
              return;
            default:
              yield* applyItem(threadId, seq, event);
          }
        });

      const ingestThread = (workerId: string, journalId: string, threadId: string, events: readonly ThreadEvent[]) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const locked = yield* sql<{ last_seq: string }>`SELECT last_seq FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;
            if (!locked[0]) return undefined;
            let last = BigInt(locked[0].last_seq);
            const ids = events.map((e) => e.eventId);
            const known = new Set(
              (yield* sql<{ event_id: string }>`SELECT event_id FROM thread_events WHERE thread_id = ${threadId}::uuid AND event_id = ANY(${ids}::uuid[])`).map(
                (r) => r.event_id,
              ),
            );
            const stored: StoredEvent[] = [];
            for (const incoming of events) {
              if (known.has(incoming.eventId)) continue;
              known.add(incoming.eventId);
              const seq = ++last;
              const event = yield* resolveTurn(threadId, incoming);
              const payload = toJson(ThreadEventSchema, create(ThreadEventSchema, { ...event, rawJson: "" }));
              yield* sql`
                INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, raw, occurred_at)
                VALUES (${threadId}::uuid, ${seq}, ${event.eventId}::uuid, 'worker', ${event.turnId || null}::uuid, ${eventKind(event)},
                        ${eventItemId(event.body) ?? null}, ${JSON.stringify(payload)}::jsonb,
                        ${event.rawJson ? event.rawJson : null}::jsonb,
                        ${event.occurredAt ? new Date(Number(event.occurredAt.seconds) * 1000 + event.occurredAt.nanos / 1e6) : new Date()})
              `;
              yield* applySideEffects(threadId, seq, event);
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

      return Ingest.of({
        ingest: Effect.fn("Ingest.ingest")(function* (workerId: string, journalId: string, events: readonly ThreadEvent[]) {
          const byThread = new Map<string, ThreadEvent[]>();
          for (const event of [...events].sort((a, b) => (a.journalSeq < b.journalSeq ? -1 : a.journalSeq > b.journalSeq ? 1 : 0))) {
            byThread.set(event.threadId, [...(byThread.get(event.threadId) ?? []), event]);
          }
          const acks = new Map<string, bigint>();
          const stored: StoredEvent[] = [];
          const unknownThreads: string[] = [];
          const failedThreads: { threadId: string; error: SqlError.SqlError }[] = [];
          for (const [threadId, threadEvents] of byThread) {
            // One thread's failure must not stop the others (or the worker link): it is not acked, so the
            // worker keeps its events and resends them after reconnecting (the core asks it to).
            const result = yield* ingestThread(workerId, journalId, threadId, threadEvents).pipe(
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

function turnStatus(outcome: TurnOutcome): "completed" | "interrupted" | "failed" {
  switch (outcome) {
    case TurnOutcome.COMPLETED:
      return "completed";
    case TurnOutcome.INTERRUPTED:
      return "interrupted";
    default:
      return "failed";
  }
}

function threadStatus(status: ThreadStatus): string | undefined {
  switch (status) {
    case ThreadStatus.IDLE:
      return "idle";
    case ThreadStatus.RUNNING:
      return "running";
    case ThreadStatus.WAITING_INPUT:
      return "waiting_input";
    case ThreadStatus.INTERRUPTED:
      return "interrupted";
    case ThreadStatus.FAILED:
      return "failed";
    default:
      return undefined;
  }
}
