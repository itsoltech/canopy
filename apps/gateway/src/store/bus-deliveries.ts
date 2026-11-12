import { create, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { type ThreadRow, type TurnRow } from "./store.ts";

import {
  inputJson,
  type BusCallRow,
  type DeliveryRow,
  type ForwardedInteraction,
  type Fx,
  type Notification,
  type TurnInput,
} from "./agent-bus-types.ts";
import { lastMessage, queueTurn, thread } from "./agent-bus-queries.ts";
import { deduplicateMessageReport, waitingForMessage } from "./bus-messages.ts";

export interface BusDeliveryStore {
  /** Pending interactions routed to the caller (from its side threads). */
  parentInteractions(
    callerId: string,
  ): Fx<ReadonlyArray<{ request_id: string; thread_id: string; kind: string; tool_name: string; request: JsonValue }>>;
  /**
   * Deliveries of spawn_thread / send_message calls: the latest of a calling thread (its snapshot), those that reached
   * a turn (its status changed) or the one behind an agent's steer.
   */
  deliveries(
    by: { sourceThreadId: string; callIds?: string[] } | { turnId: string } | { steerId: string },
  ): Fx<ReadonlyArray<DeliveryRow>>;
  /** Notifications due because `turnId` finished. */
  dueNotifications(turnId?: string, afterId?: string): Fx<Notification[]>;
  /** A report whose steer failed or whose receiving turn ended without it. Restart reconciliation. */
  notificationFallbacks(afterId?: string): Fx<string[]>;
  /** Steers into the caller's running turn, otherwise queues an agent_bus turn. */
  deliverNotification(callId: string, input: TurnInput): Fx<{ turn?: TurnRow; steerId?: string } | undefined>;
  /**
   * A side thread with interaction_route = parent asks: queue a turn in the parent (trigger = interaction)
   * unless one exists already or the agent chain is too long (then the user answers in the UI).
   */
  forwardInteraction(input: {
    requestId: string;
    input: (thread: ThreadRow) => TurnInput;
    maxHops: number;
  }): Fx<ForwardedInteraction | undefined>;
}

const deliverNotification = (sql: SqlClient.SqlClient, callId: string, input: TurnInput) =>
  sql.withTransaction(
    Effect.gen(function* () {
      // Same lock order as consumption and QueueStore.whileHead.
      const sources =
        yield* sql<ThreadRow>`SELECT t.* FROM threads t JOIN agent_bus_calls c ON c.source_thread_id = t.id
            WHERE c.id = ${callId}::uuid FOR UPDATE OF t`;

      const rows = yield* sql<BusCallRow>`
            SELECT c.* FROM agent_bus_calls c
             WHERE c.id = ${callId}::uuid AND c.notify_status = 'pending' FOR UPDATE OF c`;

      const call = rows[0];

      if (!call) return undefined; // delivered meanwhile
      const caller = sources[0];

      if (!caller || caller.archived_at || caller.deleted_at) {
        yield* sql`UPDATE agent_bus_calls SET notify_status = 'cancelled' WHERE id = ${callId}::uuid`;

        return undefined;
      }

      const running = (yield* sql<{
        id: string;
      }>`SELECT id FROM turns WHERE thread_id = ${call.source_thread_id}::uuid AND status = 'running' LIMIT 1`)[0];

      if (running && (yield* waitingForMessage(sql, caller.id, running.id, call.target_thread_id!))) return undefined;

      // Several admitted messages can point to the same target turn (including its spawn).
      // Claim its result once per recipient, under the same lock as reads and fallback.
      const reported = yield* sql`SELECT id FROM agent_bus_calls
        WHERE source_thread_id = ${caller.id}::uuid AND target_turn_id = ${call.target_turn_id}::uuid
          AND id <> ${call.id}::uuid
          AND notify_status IN ('steering', 'delivered', 'consumed_by_wait', 'consumed_by_read', 'superseded') LIMIT 1`;

      if (reported.length > 0) {
        yield* sql`UPDATE agent_bus_calls SET notify_status = 'superseded' WHERE id = ${callId}::uuid`;

        return undefined;
      }

      if (
        yield* deduplicateMessageReport(
          sql,
          caller.id,
          call.target_thread_id!,
          call.target_turn_id!,
          yield* lastMessage(sql, call.target_thread_id!, call.target_turn_id!),
        )
      ) {
        yield* sql`UPDATE agent_bus_calls SET notify_status = 'superseded' WHERE id = ${callId}::uuid`;

        return undefined;
      }

      const hops = Math.min((call.hops ?? 0) + 1, 16);

      if (running && caller.worker_id) {
        const steerId = Bun.randomUUIDv7();
        yield* sql`INSERT INTO turn_steers(id, thread_id, turn_id, input, notification_call_id, hops)
              VALUES (${steerId}::uuid, ${caller.id}::uuid, ${running.id}::uuid, ${inputJson(input)}::jsonb, ${callId}::uuid, ${hops})`;

        const command = create(CommandSchema, {
          commandId: steerId,
          kind: {
            case: "steerTurn",
            value: {
              threadId: caller.id,
              turnId: running.id,
              inputId: steerId,
              input: {
                text: input.message ? `${input.note}\n\n${input.message}` : input.note,
                authorAgentId: call.target_thread_id!,
              },
            },
          },
        });

        yield* sql`INSERT INTO worker_commands(id, worker_id, thread_id, kind, payload, expires_at)
              VALUES (${steerId}::uuid, ${caller.worker_id}::uuid, ${caller.id}::uuid, 'steerTurn', ${toBinary(CommandSchema, command)}, now() + interval '24 hours')`;
        yield* sql`UPDATE agent_bus_calls SET notify_status = 'steering', notified_steer_id = ${steerId}::uuid WHERE id = ${callId}::uuid`;

        return { steerId };
      }

      const turn = yield* queueTurn(sql, {
        threadId: call.source_thread_id,
        input,
        trigger: "agent_bus",
        callId,
        hops,
      });

      yield* sql`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = ${turn.id}::uuid WHERE id = ${callId}::uuid`;

      return { turn };
    }),
  );

export function busDeliveryStore(sql: SqlClient.SqlClient): BusDeliveryStore {
  const store: BusDeliveryStore = {
    parentInteractions: (callerId) =>
      sql<{ request_id: string; thread_id: string; kind: string; tool_name: string; request: JsonValue }>`
            SELECT i.id AS request_id, i.thread_id, i.kind, i.tool_name, i.request FROM interaction_requests i
              JOIN threads t ON t.id = i.thread_id
             WHERE t.parent_thread_id = ${callerId}::uuid AND i.status = 'pending' AND i.routed_to = 'parent'
             ORDER BY i.created_at`,

    deliveries: (by) => {
      // A steer that fell back is a queued message; one on its way has no turn of its own yet.
      const select = `
            SELECT c.id AS call_id, c.source_thread_id, c.target_thread_id, coalesce(c.target_turn_id, st.queued_turn_id) AS target_turn_id,
                   CASE WHEN st.id IS NOT NULL AND st.status <> 'queued' THEN 'steer' ELSE 'queue' END AS delivery,
                   coalesce(CASE WHEN st.status IN ('pending', 'accepted', 'dropped') THEN 'steering' WHEN st.status = 'failed' THEN 'failed' END,
                            u.status, 'queued') AS status
              FROM agent_bus_calls c
              LEFT JOIN turn_steers st ON st.agent_call_id = c.id
              LEFT JOIN turns u ON u.id = coalesce(c.target_turn_id, st.queued_turn_id)
             WHERE c.tool IN ('spawn_thread', 'send_message') AND c.status = 'completed' AND c.target_thread_id IS NOT NULL`;

      return "sourceThreadId" in by
        ? sql.unsafe<DeliveryRow>(
            `${select} AND c.source_thread_id = $1::uuid AND ($2::uuid[] IS NULL OR c.id=ANY($2::uuid[])) ORDER BY c.created_at DESC LIMIT 200`,
            [by.sourceThreadId, by.callIds ?? null],
          )
        : "turnId" in by
          ? sql.unsafe<DeliveryRow>(`${select} AND (c.target_turn_id = $1::uuid OR st.queued_turn_id = $1::uuid)`, [
              by.turnId,
            ])
          : sql.unsafe<DeliveryRow>(`${select} AND st.id = $1::uuid`, [by.steerId]);
    },

    dueNotifications: (turnId, afterId) =>
      sql<{
        id: string;
        source_thread_id: string;
        target_id: string;
        target_title: string;
        target_kind: ThreadRow["kind"];
        turn_status: string;
        last_message: string;
        last_message_length: number;
      }>`
              WITH due AS MATERIALIZED (
              SELECT c.id,c.source_thread_id,c.target_turn_id,c.created_at,
                t.id AS target_id,t.title AS target_title,t.kind AS target_kind,u.status AS turn_status
              FROM agent_bus_calls c JOIN turns u ON u.id = c.target_turn_id JOIN threads t ON t.id=c.target_thread_id
               WHERE (${turnId ?? null}::uuid IS NULL OR c.target_turn_id = ${turnId ?? null}::uuid) AND c.notify_status = 'pending'
                 AND t.deleted_at IS NULL
                 ${afterId ? sql`AND (c.created_at,c.id)>(SELECT created_at,id FROM agent_bus_calls WHERE id=${afterId}::uuid)` : sql``}
                 AND u.status IN ('completed', 'interrupted', 'failed', 'cancelled')
               ORDER BY c.created_at, c.id LIMIT 50
              ), answers AS MATERIALIZED (
                SELECT d.target_turn_id,coalesce(left(a.text,20001),'') AS last_message,
                  coalesce(length(a.text)+regexp_count(a.text,U&'[\\+010000-\\+10FFFF]'),0) AS last_message_length
                FROM (SELECT DISTINCT target_id,target_turn_id FROM due) d
                LEFT JOIN LATERAL (SELECT i.content->'agentMessage'->>'text' AS text FROM thread_items i
                  WHERE i.thread_id=d.target_id AND i.turn_id=d.target_turn_id AND i.type='agent_message'
                  ORDER BY i.first_seq DESC LIMIT 1) a ON true
              ) SELECT d.id,d.source_thread_id,d.target_id,d.target_title,d.target_kind,d.turn_status,
                a.last_message,a.last_message_length FROM due d JOIN answers a USING(target_turn_id)
              ORDER BY d.created_at,d.id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            call: { id: row.id, source_thread_id: row.source_thread_id },
            target: { id: row.target_id, title: row.target_title, kind: row.target_kind },
            turnStatus: row.turn_status,
            lastMessage: row.last_message,
            lastMessageLength: row.last_message_length,
          })),
        ),
      ),

    notificationFallbacks: (afterId) =>
      sql<{ id: string }>`
          SELECT s.id FROM turn_steers s JOIN agent_bus_calls c ON c.id = s.notification_call_id
            JOIN turns u ON u.id = s.turn_id LEFT JOIN worker_commands w ON w.id = s.id
           WHERE c.notify_status = 'steering' AND s.status IN ('pending', 'accepted', 'dropped')
             AND (${afterId ?? null}::uuid IS NULL OR s.id>${afterId ?? null}::uuid)
             AND (s.status = 'dropped' OR u.status IN ('completed', 'interrupted', 'failed', 'cancelled')
                  OR w.status = 'failed' OR (w.status IN ('pending', 'delivered') AND w.expires_at <= now()))
           ORDER BY s.id LIMIT 64`.pipe(Effect.map((rows) => rows.map((r) => r.id))),

    deliverNotification: (callId, input) => deliverNotification(sql, callId, input),

    forwardInteraction: ({ requestId, input, maxHops }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            thread_id: string;
            hops: number | null;
            status: string;
            routed_to: string;
            forwarded: boolean;
          }>`
                SELECT i.thread_id, u.hops, i.status, i.routed_to,
                       EXISTS (SELECT 1 FROM turns f WHERE f.interaction_request_id = i.id) AS forwarded
                  FROM interaction_requests i LEFT JOIN turns u ON u.id = i.turn_id
                 WHERE i.id = ${requestId}::uuid FOR UPDATE OF i`;

          const row = rows[0];

          if (!row || row.routed_to !== "parent" || row.status !== "pending" || row.forwarded) return undefined;
          const asking = yield* thread(sql, row.thread_id);

          if (!asking.parent_thread_id) return undefined;
          const hops = (row.hops ?? 0) + 1;

          if (hops > maxHops) return undefined; // agent chain too long: the user answers in the UI

          const turn = yield* queueTurn(sql, {
            threadId: asking.parent_thread_id,
            input: input(asking),
            trigger: "interaction",
            interactionId: requestId,
            hops,
          });

          return { parentThreadId: asking.parent_thread_id, turn };
        }),
      ),
  };

  return store;
}
