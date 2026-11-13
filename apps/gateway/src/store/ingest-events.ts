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
} from "@canopy/contracts";
import {
  DEFAULT_BUS_LIMITS,
  eventItemId,
  eventKind,
  itemStatus,
  itemType,
  previewRefs,
  reduceItem,
  stoppedByUser,
} from "@canopy/domain";
import { timestampDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { applyGoalState } from "./goals.ts";

/** A worker's steer_dropped notice names the dropped steer as input_id. */
const decodeSteerDropped = Schema.decodeUnknownOption(Schema.Struct({ input_id: Schema.optional(Schema.String) }));

/** How a turn ended, as stored on the turn. */
interface TurnEnd {
  status: "completed" | "interrupted" | "failed";
  errorSource: "platform" | "harness" | null;
  interruptSource: "user" | "system" | null;
}

export /** Turn states that end it. */
const ENDED = ["completed", "interrupted", "failed", "cancelled"];

// The provider runs one turn at a time per thread: when it starts another, a turn still marked running
// here lost its turn_finished (e.g. a provider crash) and is over.
export const supersede = (sql: SqlClient.SqlClient, threadId: string, turnId: string) =>
  sql`
    UPDATE turns SET status = 'interrupted', interrupt_source = 'system', interrupt_reason = 'superseded: the provider started another turn',
                     completed_at = now()
     WHERE thread_id = ${threadId}::uuid AND status = 'running' AND id <> ${turnId}::uuid
  `;

export const ensureTurn = (
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
  trigger: "provider" | "recovery",
) =>
  Effect.gen(function* () {
    const exists = yield* sql`SELECT 1 FROM turns WHERE id = ${turnId}::uuid`;

    if (exists.length > 0) return;
    yield* supersede(sql, threadId, turnId);
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
export const resolveTurn = (sql: SqlClient.SqlClient, threadId: string, event: ThreadEvent, admit = true) =>
  Effect.gen(function* () {
    if (!event.turnId) return event;

    if (admit && event.body.case === "turnStarted") {
      yield* ensureTurn(sql, threadId, event.turnId, "provider");

      return event;
    }

    const exists = yield* sql`SELECT 1 FROM turns WHERE id = ${event.turnId}::uuid AND thread_id = ${threadId}::uuid`;

    return exists.length > 0 ? event : create(ThreadEventSchema, { ...event, turnId: "" });
  });

export const applyItem = (sql: SqlClient.SqlClient, threadId: string, seq: bigint, event: ThreadEvent) =>
  Effect.gen(function* () {
    const itemId = eventItemId(event.body);

    if (!itemId) return;

    const rows = yield* sql<{ content: JsonValue }>`
      SELECT content FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ${itemId} FOR UPDATE
    `;

    const current: Item | undefined = rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined;

    // A background task's first end is its end (e.g. worker_shutdown with its time; a later close of the same
    // task by another process does not rewrite why it ended).
    if (
      current?.content.case === "backgroundTask" &&
      current.status !== ItemStatus.IN_PROGRESS &&
      event.body.case === "itemCompleted"
    )
      return;
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

    if (
      next.content.case === "backgroundTask" &&
      next.status !== ItemStatus.IN_PROGRESS &&
      (!current || current.status === ItemStatus.IN_PROGRESS)
    ) {
      yield* noteBackgroundEnd(sql, threadId, itemId, next);
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
export const noteBackgroundEnd = (sql: SqlClient.SqlClient, threadId: string, itemId: string, item: Item) =>
  Effect.gen(function* () {
    if (item.content.case !== "backgroundTask") return;
    const task = item.content.value;

    const natural =
      item.status === ItemStatus.COMPLETED ||
      (item.status === ItemStatus.FAILED && (!task.stopReason || task.stopReason === "error"));

    const endedAt = task.endedAt ? timestampDate(task.endedAt) : new Date();
    yield* sql`
      INSERT INTO background_task_notes (thread_id, item_id, wake, harness_wakes, ended_at, hops, status, reason)
      SELECT ${threadId}::uuid, ${itemId}, ${!stoppedByUser(task.stopReason)} AND coalesce(u.hops, 0) + 1 <= ${DEFAULT_BUS_LIMITS.maxHops},
             ${natural} AND t.provider = 'claude', ${endedAt}, least(coalesce(u.hops, 0) + 1, 16),
             CASE WHEN t.archived_at IS NOT NULL OR t.deleted_at IS NOT NULL OR t.rewind_pending_id IS NOT NULL OR u.rewind_id IS NOT NULL THEN 'cancelled' ELSE 'waiting' END,
             CASE WHEN t.archived_at IS NOT NULL OR t.deleted_at IS NOT NULL OR t.rewind_pending_id IS NOT NULL OR u.rewind_id IS NOT NULL THEN 'the thread is closed or rewinding' END
        FROM threads t JOIN thread_items i ON i.thread_id = t.id AND i.item_id = ${itemId} LEFT JOIN turns u ON u.id = i.turn_id
       WHERE t.id = ${threadId}::uuid
      ON CONFLICT (thread_id, item_id) DO NOTHING`;
  });

export const applySideEffects = (sql: SqlClient.SqlClient, threadId: string, seq: bigint, event: ThreadEvent) =>
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
        yield* supersede(sql, threadId, event.turnId);
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

        if (status)
          yield* sql`UPDATE threads SET status = ${status}
            WHERE id = ${threadId}::uuid AND status NOT IN ('archived', 'creating')
              AND (${status} <> 'idle' OR NOT EXISTS (
                SELECT 1 FROM turns r WHERE r.thread_id = ${threadId}::uuid AND r.status = 'running'
              ))`;

        return;
      }

      case "goalState":
        yield* applyGoalState(sql, threadId, event.turnId, body.value);

        return;
      default:
        yield* applyItem(sql, threadId, seq, event);
    }
  });

/**
 * Steered messages (turn_steers): the user_message item that carries a steer's id is where it entered its
 * turn (delivered; an agent's call now reports that turn); a steer_dropped notice means it never did.
 */
export const applySteer = (sql: SqlClient.SqlClient, threadId: string, seq: bigint, event: ThreadEvent) =>
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
      yield* sql`UPDATE agent_bus_calls c SET notify_status = 'delivered'
        FROM turn_steers s WHERE s.id = ${steerId}::uuid AND s.thread_id = ${threadId}::uuid
          AND s.status = 'delivered' AND s.notification_call_id = c.id AND c.notify_status = 'steering'`;
    } else if (body.case === "notice" && body.value.code === "steer_dropped") {
      const data = decodeSteerDropped(JSON.parse(body.value.dataJson || "{}"));
      const inputId = Option.isSome(data) ? data.value.input_id : undefined;

      if (inputId === undefined || !isUuid(inputId)) return;
      steerId = inputId;
      yield* sql`
        UPDATE turn_steers SET status = 'dropped', reason = 'the turn ended before the message could join it', updated_at = now()
         WHERE id = ${steerId}::uuid AND thread_id = ${threadId}::uuid AND status IN ('pending', 'accepted')
      `;
    }
  });

export const insertEvent = (
  sql: SqlClient.SqlClient,
  threadId: string,
  seq: bigint,
  event: ThreadEvent,
  origin: "worker" | "gateway",
) => {
  const payload = toJson(ThreadEventSchema, create(ThreadEventSchema, { ...event, rawJson: "" }));

  return sql`
    INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, raw, occurred_at)
    VALUES (${threadId}::uuid, ${seq}, ${event.eventId}::uuid, ${origin}, ${event.turnId || null}::uuid, ${eventKind(event)},
            ${eventItemId(event.body) ?? null}, ${JSON.stringify(payload)}::jsonb,
            ${event.rawJson ? event.rawJson : null}::jsonb,
            ${event.occurredAt ? new Date(Number(event.occurredAt.seconds) * 1000 + event.occurredAt.nanos / 1e6) : new Date()})
  `;
};

/**
 * Status and source of a turn end. A worker without sources (UNSPECIFIED) reports interruptions it was asked for
 * and errors of its harness, so those are the defaults.
 */
export function turnEnd(outcome: TurnOutcome, source: TurnEndSource): TurnEnd {
  switch (outcome) {
    case TurnOutcome.COMPLETED:
      return { status: "completed", errorSource: null, interruptSource: null };
    case TurnOutcome.INTERRUPTED:
      return {
        status: "interrupted",
        errorSource: null,
        interruptSource: source === TurnEndSource.SYSTEM ? "system" : "user",
      };
    default:
      return {
        status: "failed",
        errorSource: source === TurnEndSource.PLATFORM ? "platform" : "harness",
        interruptSource: null,
      };
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
