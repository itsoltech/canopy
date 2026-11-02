import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  ItemSchema,
  ItemStatus,
  ThreadEventSchema,
  ThreadStatus,
  TurnEndSource,
  TurnOutcome,
  UsageSchema,
  type Item,
  type ThreadEvent,
} from "@open-agents/contracts";
import { DEFAULT_BUS_LIMITS, eventItemId, eventKind, itemStatus, itemType, previewRefs, reduceItem, stoppedByUser } from "@open-agents/domain";
import { timestampDate, timestampNow } from "@bufbuild/protobuf/wkt";
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
 *
 * Background tasks (docs/execution.md, "Pobudka"): their items get the event's time as start and end when the worker
 * did not stamp them, and every end writes the note the agent gets (background_task_notes, once per task).
 *
 * settle() is the safety net behind every turn end (docs/durability.md, "Stany tury i wątku"): whatever the worker
 * reported, nothing of a finished turn stays open. It writes its fixes as gateway events (origin = gateway, the
 * audit reason in raw), so the UI applies them like any event.
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

export interface SettleResult {
  /** Gateway events that closed items, in timeline order. */
  readonly stored: readonly StoredEvent[];
  /** The thread's status changed (back to idle). */
  readonly threadChanged: boolean;
}

/** Turn states that end it. */
const ENDED = ["completed", "interrupted", "failed", "cancelled"];

export class Ingest extends Context.Service<
  Ingest,
  {
    ingest(workerId: string, journalId: string, events: readonly ThreadEvent[]): Effect.Effect<IngestResult, SqlError.SqlError>;
    /**
     * Closes what a finished turn left open (docs/durability.md, "Stany tury i wątku"): items still in progress in a
     * finished turn (or outside any turn while none runs) end as interrupted, except background tasks and the
     * commands they continue; the thread goes back to idle when nothing runs (a running or waiting thread without a
     * running turn, an interrupted one, a failed one that has a provider thread). `staleSeconds` (sweep): only a
     * thread unchanged that long counts as running without a turn (a turn_started may still be on its way).
     */
    settle(threadId: string, reason: string, options?: { staleSeconds?: number }): Effect.Effect<SettleResult, SqlError.SqlError>;
    /** Threads settle() would change (the sweep). */
    unsettledThreads(staleSeconds: number): Effect.Effect<readonly string[], SqlError.SqlError>;
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
          UPDATE turns SET status = 'interrupted', interrupt_source = 'system', interrupt_reason = 'superseded: the provider started another turn',
                           completed_at = now()
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
          // A background task's first end is its end (e.g. worker_shutdown with its time; a later close of the same
          // task by another process does not rewrite why it ended).
          if (current?.content.case === "backgroundTask" && current.status !== ItemStatus.IN_PROGRESS && event.body.case === "itemCompleted") return;
          const reduced = reduceItem(current, event.body);
          if (!reduced || reduced === current) return;
          const next = stampBackgroundTask(reduced, event);
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
          if (next.content.case === "backgroundTask" && next.status !== ItemStatus.IN_PROGRESS && (!current || current.status === ItemStatus.IN_PROGRESS)) {
            yield* noteBackgroundEnd(threadId, itemId, next);
          }
          // Previews the item shows (the worker sent them before the event): readable through this thread.
          for (const { sha256 } of previewRefs(next)) {
            yield* sql`INSERT INTO thread_blobs (thread_id, sha256) VALUES (${threadId}::uuid, ${sha256}) ON CONFLICT DO NOTHING`;
          }
        });

      /**
       * A background task ended: the note its agent gets (core/background-notes.ts delivers it). Stopped by the user:
       * no turn of its own (it joins the next one). A Claude task that ended by itself: Claude may wake up for it.
       * Hops: the turn that started the task + 1; past the limit the note only joins the next turn.
       */
      const noteBackgroundEnd = (threadId: string, itemId: string, item: Item) =>
        Effect.gen(function* () {
          if (item.content.case !== "backgroundTask") return;
          const task = item.content.value;
          const natural = item.status === ItemStatus.COMPLETED || (item.status === ItemStatus.FAILED && (!task.stopReason || task.stopReason === "error"));
          const endedAt = task.endedAt ? timestampDate(task.endedAt) : new Date();
          yield* sql`
            INSERT INTO background_task_notes (thread_id, item_id, wake, harness_wakes, ended_at, hops)
            SELECT ${threadId}::uuid, ${itemId}, ${!stoppedByUser(task.stopReason)} AND coalesce(u.hops, 0) + 1 <= ${DEFAULT_BUS_LIMITS.maxHops},
                   ${natural} AND t.provider = 'claude', ${endedAt}, least(coalesce(u.hops, 0) + 1, 16)
              FROM threads t JOIN thread_items i ON i.thread_id = t.id AND i.item_id = ${itemId} LEFT JOIN turns u ON u.id = i.turn_id
             WHERE t.id = ${threadId}::uuid
            ON CONFLICT (thread_id, item_id) DO NOTHING`;
        });

      const applySideEffects = (threadId: string, seq: bigint, event: ThreadEvent) =>
        Effect.gen(function* () {
          const body = event.body;
          switch (body.case) {
            case "threadReady":
              // A new provider thread may replace the one stored (Codex: a thread without turns has no rollout to resume).
              yield* sql`
                UPDATE threads SET provider_thread_id = ${body.value.providerThreadId},
                                   status = CASE WHEN status = 'creating' THEN 'idle' ELSE status END
                 WHERE id = ${threadId}::uuid
                   AND (provider_thread_id IS NULL OR provider_thread_id = ${body.value.replacesProviderThreadId || null})
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
              const end = turnEnd(body.value.outcome, body.value.source);
              yield* sql`
                UPDATE turns SET status = ${end.status}, last_seq = ${seq}, completed_at = now(),
                                 provider_turn_ref = coalesce(${body.value.providerTurnRef || null}, provider_turn_ref),
                                 usage = ${body.value.usage ? JSON.stringify(toJson(UsageSchema, body.value.usage)) : null}::jsonb,
                                 error = ${end.status === "failed" ? body.value.reason || null : null},
                                 error_source = ${end.errorSource},
                                 error_code = ${end.status === "failed" ? body.value.errorCode || null : null},
                                 interrupt_reason = ${end.status === "interrupted" ? body.value.reason || null : null},
                                 interrupt_source = ${end.interruptSource}
                 WHERE id = ${event.turnId}::uuid AND thread_id = ${threadId}::uuid
              `;
              // Any end leaves the thread usable (idle); the turn keeps the outcome. A late end of a turn the gateway
              // already closed (e.g. worker restart) must not idle a newer running turn.
              yield* sql`
                UPDATE threads SET status = 'idle'
                 WHERE id = ${threadId}::uuid AND status NOT IN ('archived', 'creating')
                   AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = ${threadId}::uuid AND r.status = 'running' AND r.id <> ${event.turnId || null}::uuid)
              `;
              return;
            }
            case "activity": {
              // Only what the thread does now; how a turn ended is the turn's (a provider's error state of the thread,
              // e.g. Codex systemError, does not make the thread unusable: the next turn resumes it).
              const status = threadStatus(body.value.status);
              if (status) yield* sql`UPDATE threads SET status = ${status} WHERE id = ${threadId}::uuid AND status NOT IN ('archived', 'creating')`;
              return;
            }
            case "goalState":
              yield* applyGoalState(sql, threadId, event.turnId, body.value);
              return;
            default:
              yield* applyItem(threadId, seq, event);
          }
        });

      /**
       * Steered messages (turn_steers): the user_message item that carries a steer's id is where it entered its
       * turn (delivered; an agent's call now reports that turn); a steer_dropped notice means it never did.
       */
      const applySteer = (threadId: string, seq: bigint, event: ThreadEvent) =>
        Effect.gen(function* () {
          const body = event.body;
          let steerId: string | undefined;
          if (body.case === "itemCompleted" && body.value.item?.content.case === "userMessage") {
            steerId = body.value.item.content.value.clientId;
            if (!steerId || !isUuid(steerId) || steerId === event.turnId) return;
            yield* sql`
              WITH s AS (
                UPDATE turn_steers SET status = 'delivered', delivered_seq = ${seq}, updated_at = now()
                 WHERE id = ${steerId}::uuid AND thread_id = ${threadId}::uuid AND status IN ('pending', 'accepted')
                RETURNING agent_call_id, turn_id)
              UPDATE agent_bus_calls c SET target_turn_id = s.turn_id FROM s WHERE c.id = s.agent_call_id AND c.target_turn_id IS NULL
            `;
            // A note about background tasks (a steer of the platform's) reached its agent.
            yield* sql`
              UPDATE background_task_notes SET status = 'delivered', updated_at = now()
               WHERE thread_id = ${threadId}::uuid AND steer_id = ${steerId}::uuid AND status = 'steering'
            `;
          } else if (body.case === "notice" && body.value.code === "steer_dropped") {
            steerId = (JSON.parse(body.value.dataJson || "{}") as { input_id?: unknown }).input_id as string | undefined;
            if (typeof steerId !== "string" || !isUuid(steerId)) return;
            yield* sql`
              UPDATE turn_steers SET status = 'dropped', reason = 'the turn ended before the message could join it', updated_at = now()
               WHERE id = ${steerId}::uuid AND thread_id = ${threadId}::uuid AND status IN ('pending', 'accepted')
            `;
          }
        });

      const insertEvent = (threadId: string, seq: bigint, event: ThreadEvent, origin: "worker" | "gateway") => {
        const payload = toJson(ThreadEventSchema, create(ThreadEventSchema, { ...event, rawJson: "" }));
        return sql`
          INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, raw, occurred_at)
          VALUES (${threadId}::uuid, ${seq}, ${event.eventId}::uuid, ${origin}, ${event.turnId || null}::uuid, ${eventKind(event)},
                  ${eventItemId(event.body) ?? null}, ${JSON.stringify(payload)}::jsonb,
                  ${event.rawJson ? event.rawJson : null}::jsonb,
                  ${event.occurredAt ? new Date(Number(event.occurredAt.seconds) * 1000 + event.occurredAt.nanos / 1e6) : new Date()})
        `;
      };

      /** No turn of the thread runs. */
      const idleTurns = (threadId: string) => sql`NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = ${threadId}::uuid AND r.status = 'running')`;

      /**
       * Items settle() closes: open, not a background task (those outlive turns; the worker ends them with their
       * process), not a command a running background task continues (Codex keeps its item open until the process
       * exits), in a finished turn, or outside any turn while none runs.
       */
      const openLeftovers = (threadId: string) => sql<{ item_id: string; turn_id: string | null; content: JsonValue }>`
        SELECT i.item_id, i.turn_id, i.content FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
         WHERE i.thread_id = ${threadId}::uuid AND i.status = 'in_progress' AND i.type NOT IN ('background_task', 'interaction_prompt')
           AND (u.status = ANY(${ENDED}::text[]) OR (i.turn_id IS NULL AND ${idleTurns(threadId)}))
           AND NOT EXISTS (SELECT 1 FROM thread_items b
                            WHERE b.thread_id = i.thread_id AND b.type = 'background_task' AND b.status = 'in_progress'
                              AND b.content->'backgroundTask'->>'sourceItemId' = i.item_id)
         ORDER BY i.first_seq`;

      /** A thread whose status says it works or failed while it can take the next turn. */
      const stuckThread = (staleSeconds: number) => sql`
        t.archived_at IS NULL AND (
          t.status = 'interrupted'
          OR (t.status = 'failed' AND t.provider_thread_id IS NOT NULL)
          OR (t.status IN ('running', 'waiting_input') AND t.updated_at <= now() - make_interval(secs => ${staleSeconds})
              AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')
              AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id AND c.kind = 'startTurn' AND c.status IN ('pending', 'delivered'))))`;

      const settleThread = (threadId: string, reason: string, staleSeconds: number) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const locked = yield* sql<{ last_seq: string }>`SELECT last_seq FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;
            if (!locked[0]) return { stored: [], threadChanged: false };
            let last = BigInt(locked[0].last_seq);
            const stored: StoredEvent[] = [];
            for (const row of yield* openLeftovers(threadId)) {
              const item = fromJson(ItemSchema, row.content);
              item.status = ItemStatus.INTERRUPTED;
              const event = create(ThreadEventSchema, {
                eventId: Bun.randomUUIDv7(),
                threadId,
                turnId: row.turn_id ?? "",
                occurredAt: timestampNow(),
                // The audit trail: who closed the item and why (thread_events.raw).
                rawJson: JSON.stringify({ settled_by: "gateway", reason }),
                body: { case: "itemCompleted", value: { item } },
              });
              const seq = ++last;
              yield* insertEvent(threadId, seq, event, "gateway");
              yield* applyItem(threadId, seq, event);
              stored.push({ threadId, seq, event });
            }
            if (stored.length > 0) yield* sql`UPDATE threads SET last_seq = ${last} WHERE id = ${threadId}::uuid`;
            const changed = yield* sql`
              UPDATE threads t SET status = 'idle', status_detail = NULL
               WHERE t.id = ${threadId}::uuid AND ${stuckThread(staleSeconds)}
              RETURNING t.id`;
            return { stored, threadChanged: changed.length > 0 };
          }),
        );

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
              yield* insertEvent(threadId, seq, event, "worker");
              yield* applySideEffects(threadId, seq, event);
              yield* applySteer(threadId, seq, event);
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
        settle: Effect.fn("Ingest.settle")((threadId: string, reason: string, options?: { staleSeconds?: number }) =>
          settleThread(threadId, reason, options?.staleSeconds ?? 0),
        ),
        unsettledThreads: Effect.fn("Ingest.unsettledThreads")(function* (staleSeconds: number) {
          const rows = yield* sql<{ id: string }>`
            SELECT t.id FROM threads t
             WHERE t.archived_at IS NULL AND (
               ${stuckThread(staleSeconds)}
               OR EXISTS (SELECT 1 FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
                           WHERE i.thread_id = t.id AND i.status = 'in_progress' AND i.type NOT IN ('background_task', 'interaction_prompt')
                             AND (u.status = ANY(${ENDED}::text[])
                                  OR (i.turn_id IS NULL AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')))
                             AND NOT EXISTS (SELECT 1 FROM thread_items b
                                              WHERE b.thread_id = i.thread_id AND b.type = 'background_task' AND b.status = 'in_progress'
                                                AND b.content->'backgroundTask'->>'sourceItemId' = i.item_id))
               OR EXISTS (SELECT 1 FROM interaction_requests q JOIN turns u ON u.id = q.turn_id
                           WHERE q.thread_id = t.id AND q.status = 'pending' AND q.question_call_id IS NULL AND u.status = ANY(${ENDED}::text[])))
             ORDER BY t.id`;
          return rows.map((r) => r.id);
        }),
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

/**
 * Status and source of a turn end. A worker without sources (UNSPECIFIED) reports interruptions it was asked for
 * and errors of its harness, so those are the defaults.
 */
export function turnEnd(
  outcome: TurnOutcome,
  source: TurnEndSource,
): { status: "completed" | "interrupted" | "failed"; errorSource: "platform" | "harness" | null; interruptSource: "user" | "system" | null } {
  switch (outcome) {
    case TurnOutcome.COMPLETED:
      return { status: "completed", errorSource: null, interruptSource: null };
    case TurnOutcome.INTERRUPTED:
      return { status: "interrupted", errorSource: null, interruptSource: source === TurnEndSource.SYSTEM ? "system" : "user" };
    default:
      return { status: "failed", errorSource: source === TurnEndSource.PLATFORM ? "platform" : "harness", interruptSource: null };
  }
}

/** A background task's start and end default to its event's time (a worker that did not stamp them). */
function stampBackgroundTask(item: Item, event: ThreadEvent): Item {
  if (item.content.case !== "backgroundTask") return item;
  const task = item.content.value;
  const ended = item.status !== ItemStatus.IN_PROGRESS;
  if (task.startedAt && (!ended || task.endedAt)) return item;
  const stamped = clone(ItemSchema, item);
  if (stamped.content.case !== "backgroundTask") return item;
  const at = event.occurredAt ?? timestampNow();
  stamped.content.value.startedAt ??= at;
  if (ended) stamped.content.value.endedAt ??= at;
  return stamped;
}

function threadStatus(status: ThreadStatus): string | undefined {
  switch (status) {
    case ThreadStatus.IDLE:
      return "idle";
    case ThreadStatus.RUNNING:
      return "running";
    case ThreadStatus.WAITING_INPUT:
      return "waiting_input";
    default:
      return undefined;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

