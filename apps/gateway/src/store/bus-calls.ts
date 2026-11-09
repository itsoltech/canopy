import { type JsonValue } from "@bufbuild/protobuf";
import {
  type BusFacts,
  type InteractionFacts,
  type ScheduleFacts,
  type SpawnTarget,
  type ThreadNode,
} from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { type ThreadRow } from "./store.ts";
import type { AgentBusArgs } from "@canopy/domain";
import { recordBusCall } from "./bus-call-record.ts";

import { type BusCallRow, type CallSource, type Fx } from "./agent-bus-types.ts";
import {
  callerMode,
  consumeNotifications,
  isUuid,
  node,
  nodeColumns,
  type ThreadNodeRow,
  thread,
  turnRef,
} from "./agent-bus-queries.ts";

export interface BusCallStore {
  /** Serialize the returned snapshot and its durable observation with input delivery. */
  observe<A, E, R>(recipient: string, read: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError, R>;
  beginWait(source: CallSource, args: AgentBusArgs["wait_threads"]): Fx<Date>;
  storedCall(callId: string): Fx<BusCallRow | undefined>;
  /** Loads the caller, the addressed threads and the counts `authorizeBusCall` needs. */
  facts(input: {
    source: CallSource;
    targetIds: readonly string[];
    /** spawn_thread: where the new thread runs (resolveSpawnTarget), for the fork rule. */
    spawnTarget?: SpawnTarget;
    interactionId?: string;
    scheduleId?: string;
    /** schedule_*: the thread whose active schedules count against the limit. */
    scheduleThreadId?: string;
  }): Fx<{ caller: ThreadRow; facts: BusFacts }>;
  /** A call that started nothing (reads, refusals, interrupts): stored with its result for idempotency. */
  recordCall(input: {
    source: CallSource;
    tool: string;
    args: unknown;
    ok: boolean;
    result?: JsonValue;
    error?: string;
    observedTurnIds?: readonly string[];
  }): Fx<void>;
  /** The caller explicitly stopped caring about a target, before interrupting it. */
  supersedeNotifications(callerId: string, targetId: string): Fx<void>;
}

export function busCallStore(sql: SqlClient.SqlClient): BusCallStore {
  const store: BusCallStore = {
    observe: (recipient, read) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM threads WHERE id = ${recipient}::uuid FOR UPDATE`;

          return yield* read;
        }),
      ),
    beginWait: (source, args) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM threads WHERE id = ${source.threadId}::uuid FOR UPDATE`;
          yield* sql`INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, source_item_id, tool, arguments, status)
        VALUES (${source.callId}::uuid, ${source.threadId}::uuid, ${turnRef(sql, source)}, ${source.itemId || null},
          'wait_threads', ${JSON.stringify(args)}::jsonb, 'requested') ON CONFLICT (id) DO NOTHING`;

          const rows = yield* sql<{ deadline: Date }>`SELECT created_at +
            coalesce((arguments->>'timeout_seconds')::int, 120) * interval '1 second' AS deadline
            FROM agent_bus_calls WHERE id = ${source.callId}::uuid`;

          return rows[0]!.deadline;
        }),
      ),
    storedCall: (callId) =>
      isUuid(callId)
        ? sql<BusCallRow>`SELECT * FROM agent_bus_calls WHERE id = ${callId}::uuid`.pipe(Effect.map((rows) => rows[0]))
        : Effect.succeed(undefined),

    facts: ({ source, targetIds, spawnTarget, interactionId, scheduleId, scheduleThreadId }) =>
      Effect.gen(function* () {
        const caller = yield* thread(sql, source.threadId);
        const hopsRows = yield* sql<{ hops: number }>`SELECT hops FROM turns WHERE id = ${turnRef(sql, source)}`;
        const targets = new Map<string, ThreadNode>();

        const ids = [...new Set(targetIds)].filter(isUuid);

        const addressed = ids.length
          ? yield* sql.unsafe<ThreadNodeRow>(
              `SELECT ${nodeColumns} FROM threads WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`,
              [ids],
            )
          : [];

        const byId = new Map(addressed.map((row) => [row.id, node(row)]));

        for (const id of ids) {
          const target = byId.get(id.toLowerCase());

          if (target) targets.set(id, target);
        }

        const counts = yield* sql<{ children: number; active: number }>`
              SELECT (SELECT count(*)::int FROM threads c WHERE c.parent_thread_id = ${caller.id}::uuid AND c.archived_at IS NULL AND c.deleted_at IS NULL) AS children,
                     (SELECT count(*)::int FROM threads t WHERE t.root_thread_id = ${caller.root_thread_id}::uuid AND t.archived_at IS NULL AND t.deleted_at IS NULL
                         AND (t.status IN ('creating', 'running', 'waiting_input')
                              OR EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued'))) AS active`;

        let interaction: InteractionFacts | undefined;

        if (interactionId && isUuid(interactionId)) {
          const rows = yield* sql<{
            id: string;
            thread_id: string;
            kind: InteractionFacts["kind"];
            routed_to: InteractionFacts["routedTo"];
            status: string;
          }>`
                SELECT id, thread_id, kind, routed_to, status FROM interaction_requests WHERE id = ${interactionId}::uuid`;

          const row = rows[0];

          if (row) {
            interaction = {
              id: row.id,
              threadId: row.thread_id,
              kind: row.kind,
              routedTo: row.routed_to,
              status: row.status,
            };

            const owner = yield* sql.unsafe<ThreadNodeRow>(`SELECT ${nodeColumns} FROM threads WHERE id=$1::uuid`, [
              row.thread_id,
            ]);

            if (owner[0]) targets.set(row.thread_id, node(owner[0]));
          }
        }

        let schedule: ScheduleFacts | undefined;

        if (scheduleId && isUuid(scheduleId)) {
          const rows = yield* sql<{ id: string; thread_id: string }>`
                SELECT id, thread_id FROM schedules WHERE id = ${scheduleId}::uuid AND status IN ('active', 'paused')`;

          if (rows[0]) {
            schedule = { id: rows[0].id, threadId: rows[0].thread_id };

            const owner = yield* sql.unsafe<ThreadNodeRow>(`SELECT ${nodeColumns} FROM threads WHERE id=$1::uuid`, [
              rows[0].thread_id,
            ]);

            if (owner[0]) targets.set(owner[0].id, node(owner[0]));
          }
        }

        const scheduleCount =
          scheduleThreadId && isUuid(scheduleThreadId)
            ? (yield* sql<{ n: number }>`
                    SELECT count(*)::int AS n FROM schedules WHERE thread_id = ${scheduleThreadId}::uuid AND status IN ('active', 'paused')`)[0]
                ?.n
            : undefined;

        const facts: BusFacts = {
          caller: node(caller),
          callerHops: hopsRows[0]?.hops ?? 0,
          targets,
          callerChildren: counts[0]?.children ?? 0,
          activeInTree: counts[0]?.active ?? 0,
          callerPermissionMode: yield* callerMode(sql, source, caller),
          ...(spawnTarget && {
            spawnProvider: spawnTarget.harness,
            spawnInstance: spawnTarget.instance || "native",
          }),
          ...(interaction && { interaction }),
          ...(schedule && { schedule }),
          ...(scheduleCount !== undefined && { targetSchedules: scheduleCount }),
          now: new Date(),
        };

        return { caller, facts };
      }),

    recordCall: (input) => recordBusCall(sql, input),

    supersedeNotifications: (callerId, targetId) =>
      sql.withTransaction(consumeNotifications(sql, callerId, "superseded", { targetId })),
  };

  return store;
}
