import { reportFailureReason } from "./turn-report.ts";
import { hasDelegatingBot } from "./rows.ts";
import { STARTED_BY_BOT } from "./thread-select.ts";
import { type JsonValue } from "@bufbuild/protobuf";
import { agentKey, SPAWN_PERMISSION_MODES, type ThreadNode } from "@canopy/domain";
import { Effect, Match } from "effect";
import type { SqlClient } from "effect/sql";
import { NotFound, type ThreadRow, type TurnRow } from "./store.ts";

import {
  busPermissionMode,
  inputJson,
  truncate,
  type CallSource,
  type Fx,
  type ThreadSummary,
  type TurnInput,
} from "./agent-bus-types.ts";

export const thread = (sql: SqlClient.SqlClient, id: string) =>
  sql<ThreadRow>`SELECT t.*, ${sql.literal(STARTED_BY_BOT)} AS started_by_bot, (SELECT p.kind FROM projects p WHERE p.id = t.project_id) AS project_kind
    FROM threads t WHERE t.id = ${id}::uuid AND t.deleted_at IS NULL`.pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("thread not found")))),
  );

export type ThreadNodeRow = Pick<
  ThreadRow,
  | "id"
  | "root_thread_id"
  | "depth"
  | "remote_parent_ref"
  | "remote_parent_kind"
  | "remote_parent_detached"
  | "started_by_bot"
  | "parent_thread_id"
  | "owner_user_id"
  | "provider"
  | "provider_profile_id"
  | "archived_at"
>;

export const nodeColumns =
  "id,root_thread_id,depth,remote_parent_ref,parent_thread_id,owner_user_id,provider,provider_profile_id,archived_at";

export const node = (row: ThreadNodeRow): ThreadNode => ({
  id: row.id,
  hasDelegatingBot: hasDelegatingBot(row),
  rootId: row.root_thread_id,
  depth: row.remote_parent_ref ? 1 : row.depth,
  ancestorIds: row.parent_thread_id
    ? [row.parent_thread_id, ...(row.root_thread_id !== row.parent_thread_id ? [row.root_thread_id] : [])]
    : [],
  ownerId: row.owner_user_id,
  provider: row.provider,
  instance: row.provider_profile_id || "native",
  archived: row.archived_at != null,
});

export const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export const turnRef = (sql: SqlClient.SqlClient, source: Pick<CallSource, "threadId" | "turnId">) =>
  sql`(SELECT id FROM turns WHERE id = ${isUuid(source.turnId) ? source.turnId : null}::uuid AND thread_id = ${source.threadId}::uuid)`;

/** Queued inputs are not authority until they start. Legacy and deferred calls use the last durable context. */
export const busContextTurn = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<TurnRow>`
    SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND started_at IS NOT NULL
      AND rewind_id IS NULL AND trigger <> 'import'
    ORDER BY ordinal DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]));

/** Native continuations do not reset authorization to the provider's required stored hops=0. */
export const busHops = (sql: SqlClient.SqlClient, source: Pick<CallSource, "threadId" | "turnId">) =>
  sql<{ hops: number }>`
    SELECT CASE WHEN u.trigger IN ('provider', 'recovery') THEN greatest(u.hops, anchor.hops,
      (SELECT max(n.hops) FROM background_task_notes n
       WHERE n.thread_id = u.thread_id AND n.harness_wakes AND n.status <> 'cancelled'
         AND n.ended_at >= coalesce(anchor.started_at, '-infinity'::timestamptz)))
      ELSE u.hops END AS hops
      FROM turns u
      LEFT JOIN LATERAL (
        SELECT p.hops, p.started_at FROM turns p
         WHERE p.thread_id = u.thread_id AND p.ordinal < u.ordinal AND p.started_at IS NOT NULL
           AND p.trigger NOT IN ('provider', 'recovery', 'import') AND p.rewind_id IS NULL
         ORDER BY p.ordinal DESC LIMIT 1
      ) anchor ON true
     WHERE u.id = ${turnRef(sql, source)}`.pipe(Effect.map((rows) => rows[0]?.hops ?? 0));

export const lastMessage = (sql: SqlClient.SqlClient, threadId: string, turnId?: string, skipEmpty = false) =>
  sql<{ text: string | null }>`
    SELECT content->'agentMessage'->>'text' AS text FROM thread_items
     WHERE thread_id = ${threadId}::uuid AND type = 'agent_message'
       ${skipEmpty ? sql`AND content->'agentMessage'->>'text' ~ '[^[:space:]]'` : sql``}
       AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.id=thread_items.turn_id AND u.rewind_id IS NOT NULL)
       AND (${turnId ?? null}::uuid IS NULL OR turn_id = ${turnId ?? null}::uuid) ORDER BY first_seq DESC LIMIT 1`.pipe(
    Effect.map((rows) => rows[0]?.text ?? ""),
  );

export const summary = (sql: SqlClient.SqlClient, threadId: string): Fx<ThreadSummary> =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      title: string;
      kind: "main" | "side";
      parent_thread_id: string | null;
      remote_parent_ref: string | null;
      remote_parent_detached: boolean;
      status: string;
      provider: string;
      provider_profile_id: string | null;
      project: string | null;
      worker: string | null;
      settings: ThreadRow["settings"];
      running: number;
      queued: number;
      for_parent: number;
      for_user: number;
    }>`
      SELECT t.id, t.title, t.kind, t.parent_thread_id, t.remote_parent_ref, t.remote_parent_detached, t.status, t.settings, t.provider, t.provider_profile_id,
             (SELECT p.name FROM projects p WHERE p.id = t.project_id) AS project,
             (SELECT w.name FROM workers w WHERE w.id = t.worker_id) AS worker,
             (SELECT count(*)::int FROM turns u WHERE u.thread_id = t.id AND u.status = 'running') AS running,
             (SELECT count(*)::int FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued') AS queued,
             (SELECT count(*)::int FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'parent') AS for_parent,
             (SELECT count(*)::int FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'human') AS for_user
        FROM threads t WHERE t.id = ${threadId}::uuid AND t.deleted_at IS NULL`;

    const row = rows[0];

    if (!row) return yield* Effect.fail(new NotFound("thread not found"));

    const ended = (yield* sql<{
      id: string;
      status: string;
      error: string | null;
      error_source: string | null;
      interrupt_reason: string | null;
      interrupt_source: string | null;
    }>`
      SELECT id, status, error, error_source, interrupt_reason, interrupt_source FROM turns
       WHERE thread_id = ${row.id}::uuid AND rewind_id IS NULL AND status IN ('completed', 'interrupted', 'failed', 'cancelled') ORDER BY ordinal DESC LIMIT 1`)[0];

    const reason = Match.value(ended?.status).pipe(
      Match.when("failed", () =>
        [ended?.error_source, reportFailureReason(ended?.error ?? null)].filter(Boolean).join(": "),
      ),
      Match.when("interrupted", () => [ended?.interrupt_source, ended?.interrupt_reason].filter(Boolean).join(": ")),
      Match.orElse(() => ""),
    );

    return {
      thread_id: row.id,
      title: row.title,
      kind: row.remote_parent_ref ? "side" : row.kind,
      parent_thread_id: row.parent_thread_id ?? row.remote_parent_ref,
      ...(row.remote_parent_ref && { parent_detached: row.remote_parent_detached }),
      status: row.status,
      provider: agentKey({
        harness: Match.value(row.provider).pipe(
          Match.when("claude", () => "claude" as const),
          Match.when("grok", () => "grok" as const),
          Match.orElse(() => "codex" as const),
        ),
        instance: row.provider_profile_id ?? "",
      }),
      project: row.project ?? "",
      worker: row.worker ?? "",
      settled: row.running === 0 && row.queued === 0 && row.status !== "creating",
      queued_turns: row.queued,
      waiting_for_parent: row.for_parent,
      waiting_for_user: row.for_user,
      model: row.settings.model ?? "",
      effort: row.settings.effort ?? "",
      service_tier: row.settings.serviceTier ?? "",
      permission_mode: busPermissionMode(row.settings.permissionMode),
      ...(ended && {
        last_turn: {
          turn_id: ended.id,
          status: ended.status,
          ...(reason && { reason: truncate(reason, 1_000).toWellFormed() }),
        },
      }),
      last_message: ended ? truncate(yield* lastMessage(sql, row.id, ended.id, ended.status === "failed"), 4_000) : "",
    };
  });

// The source thread lock serializes observation, notification delivery and queue dispatch.
export const consumeNotifications = (
  sql: SqlClient.SqlClient,
  callerId: string,
  status: string,
  filter: { turnIds: readonly string[] } | { targetId: string },
) =>
  Effect.gen(function* () {
    yield* sql`SELECT id FROM threads WHERE id = ${callerId}::uuid FOR UPDATE`;

    const calls = yield* sql<{ id: string; notified_turn_id: string | null }>`
      SELECT c.id, c.notified_turn_id FROM agent_bus_calls c
       WHERE c.source_thread_id = ${callerId}::uuid
         AND (${"targetId" in filter ? filter.targetId : null}::uuid IS NULL
              OR c.target_thread_id = ${"targetId" in filter ? filter.targetId : null}::uuid)
         AND (${"turnIds" in filter ? `{${filter.turnIds.join(",")}}` : null}::uuid[] IS NULL
              OR c.target_turn_id = ANY(${"turnIds" in filter ? `{${filter.turnIds.join(",")}}` : null}::uuid[]))
         AND (c.notify_status IN ('pending', 'steering') OR
           (c.notify_status = 'delivered' AND EXISTS (
             SELECT 1 FROM turns u WHERE u.id = c.notified_turn_id AND u.status = 'queued'
               AND NOT EXISTS (SELECT 1 FROM worker_commands w WHERE w.turn_id = u.id AND w.status IN ('pending', 'delivered', 'completed')))))
       FOR UPDATE OF c`;

    for (const call of calls) {
      yield* sql`UPDATE agent_bus_calls SET notify_status = ${status} WHERE id = ${call.id}::uuid`;
      yield* sql`UPDATE turns SET status = 'cancelled', withdrawn = 'consumed', completed_at = now() WHERE id = ${call.notified_turn_id}::uuid AND status = 'queued'`;
      // An already dispatched input cannot be recalled. Suppress its fallback; a late acknowledgement
      // or transcript event must not resurrect it. Undispatched outbox commands are withdrawn too.
      yield* sql`UPDATE turn_steers SET status = 'failed', reason = ${status}, updated_at = now()
        WHERE notification_call_id = ${call.id}::uuid AND status IN ('pending', 'accepted', 'dropped')`;
      yield* sql`UPDATE worker_commands SET status = 'failed', completed_at = now()
        WHERE id IN (SELECT id FROM turn_steers WHERE notification_call_id = ${call.id}::uuid AND status = 'failed')
          AND status IN ('pending', 'delivered')`;
    }
  });

export const insertCall = (
  sql: SqlClient.SqlClient,
  input: {
    source: CallSource;
    tool: string;
    args: unknown;
    status: "completed" | "failed";
    result?: JsonValue;
    error?: string;
    hops?: number;
    notify?: boolean;
  },
) => sql`
  INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, source_item_id, tool, arguments, status, result, error,
                               hops, notify, notify_status, completed_at)
  VALUES (${input.source.callId}::uuid, ${input.source.threadId}::uuid, ${turnRef(sql, input.source)}, ${input.source.itemId || null},
          ${input.tool}, ${JSON.stringify(input.args ?? {})}::jsonb, ${input.status},
          ${input.result === undefined ? null : JSON.stringify(input.result)}::jsonb, ${input.error ?? null},
          ${input.hops ?? null}, ${input.notify ?? false}, ${input.notify ? "pending" : null}, now())`;

export const queueTurn = (
  sql: SqlClient.SqlClient,
  input: {
    threadId: string;
    input: TurnInput;
    trigger: "agent_bus" | "interaction";
    callId?: string;
    interactionId?: string;
    hops: number;
  },
) =>
  sql<TurnRow>`
    INSERT INTO turns (id, thread_id, ordinal, trigger, agent_call_id, interaction_request_id, hops, input)
    SELECT ${Bun.randomUUIDv7()}::uuid, ${input.threadId}::uuid, coalesce(max(ordinal), 0) + 1, ${input.trigger},
           ${input.callId ?? null}::uuid, ${input.interactionId ?? null}::uuid, ${input.hops}, ${inputJson(input.input)}::jsonb
      FROM turns WHERE thread_id = ${input.threadId}::uuid
    RETURNING *`.pipe(Effect.map((rows) => rows[0]!));

export const scheduleSelect = `
  SELECT s.*, p.owner_user_id, c.source_thread_id AS created_by_thread_id,
    (SELECT coalesce(jsonb_agg(r.data ORDER BY r.scheduled_for DESC), '[]'::jsonb) FROM
      (SELECT sr.scheduled_for, jsonb_build_object('scheduledFor', to_char(sr.scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'number', sr.number, 'threadId', coalesce(sr.thread_id::text, ''), 'turnId', coalesce(sr.turn_id::text, ''),
        'workerId', coalesce(sr.worker_id::text, ''), 'workspaceId', coalesce(sr.workspace_id::text, ''), 'outcome', sr.outcome,
        'createdAt', to_char(sr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS data
       FROM schedule_runs sr WHERE sr.schedule_id = s.id ORDER BY sr.scheduled_for DESC LIMIT 5) r) AS recent_runs
    FROM schedules s JOIN projects p ON p.id = s.project_id LEFT JOIN threads t ON t.id = s.thread_id
    LEFT JOIN agent_bus_calls c ON c.id = s.created_by_call_id`;

/**
 * A running turn may override the thread's default. Once it ends, its mode only caps the default.
 * A default changed since dispatch also caps a running turn.
 */
export const callerMode = (
  sql: SqlClient.SqlClient,
  source: Pick<CallSource, "threadId" | "turnId">,
  caller: ThreadRow,
) =>
  sql<{ permission_mode: string; thread_permission_mode: string; status: string }>`
    SELECT coalesce(nullif(u.permission_mode, ''), previous.permission_mode) AS permission_mode,
           u.thread_permission_mode, u.status
      FROM turns u
      LEFT JOIN LATERAL (
        SELECT permission_mode FROM turns p
         WHERE u.trigger IN ('provider', 'recovery') AND p.thread_id = u.thread_id AND p.ordinal < u.ordinal
           AND p.started_at IS NOT NULL AND p.trigger NOT IN ('provider', 'recovery', 'import') AND p.rewind_id IS NULL
         ORDER BY p.ordinal DESC LIMIT 1
      ) previous ON true
     WHERE u.id = ${turnRef(sql, source)}`.pipe(
    Effect.map((rows) => {
      const current = busPermissionMode(caller.settings.permissionMode);
      const turn = busPermissionMode(rows[0]?.permission_mode || caller.settings.permissionMode);
      const snapshot = rows[0]?.thread_permission_mode;

      if (rows[0]?.status === "running" && snapshot && busPermissionMode(snapshot) === current) return turn;

      return SPAWN_PERMISSION_MODES.indexOf(current) < SPAWN_PERMISSION_MODES.indexOf(turn) ? current : turn;
    }),
  );
