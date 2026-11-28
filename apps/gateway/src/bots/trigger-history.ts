import {
  eventType,
  estimateRuns,
  matchesTrigger,
  type EventFacts,
  type TriggerFilter,
} from "@canopy/domain/bot-triggers";
import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";

const SAMPLE = 20_000;

type Past = { at: Date; facts: EventFacts };

/** The bot's own work, as the matcher excludes it: watched turns always, its inputs and threads unless opted in. */
function notOwn(sql: SqlClient.SqlClient, botId: string, excludeOwn: boolean, turn: Statement.Fragment) {
  return sql`NOT EXISTS (SELECT 1 FROM bot_thread_watches w WHERE w.bot_id = ${botId}::uuid AND w.target_turn_id = ${turn})
    AND NOT (${excludeOwn} AND (
      EXISTS (SELECT 1 FROM bot_started_threads s WHERE s.thread_id = th.id AND s.bot_id = ${botId}::uuid)
      OR EXISTS (SELECT 1 FROM turns u JOIN bot_tool_calls c ON c.id = u.bot_call_id JOIN bot_turns b ON b.id = c.turn_id
        WHERE u.id = ${turn} AND b.bot_id = ${botId}::uuid)
      OR EXISTS (SELECT 1 FROM turn_steers st JOIN bot_tool_calls c ON c.id = st.bot_call_id
        JOIN bot_turns b ON b.id = c.turn_id WHERE st.turn_id = ${turn} AND b.bot_id = ${botId}::uuid
          AND st.status IN ('pending','accepted','delivered'))))`;
}

/**
 * Past occurrences of an event type over 7 days, with the same facts its source trigger records. The scope only
 * narrows the read; the matcher applies the exact filter afterwards.
 */
function history(sql: SqlClient.SqlClient, owner: string, botId: string, event: string, filter: TriggerFilter) {
  const visible = sql`th.owner_user_id = ${owner}::uuid AND th.memory_audience NOT LIKE 'conversation:%'`;

  const threadScope = sql`jsonb_build_object('project', th.project_id, 'worker', th.worker_id, 'thread', th.id)`;

  switch (event) {
    case "thread.turn_finished":
      return sql<Past>`SELECT t.completed_at AS at, jsonb_build_object('scope', ${threadScope},
          'fields', jsonb_build_object('status', t.status, 'thread_origin', th.origin)) AS facts
        FROM turns t JOIN threads th ON th.id = t.thread_id WHERE ${visible}
          AND ${notOwn(sql, botId, filter.exclude_own, sql`t.id`)} AND t.status IN ('completed','failed','interrupted') AND t.interrupt_source IS DISTINCT FROM 'user'
          AND t.completed_at > now() - interval '7 days' LIMIT ${SAMPLE}`;
    case "thread.needs_input":
      return sql<Past>`SELECT r.created_at AS at, jsonb_build_object('scope', ${threadScope},
          'fields', jsonb_build_object('kind', r.kind, 'tool_name', r.tool_name)) AS facts
        FROM interaction_requests r JOIN threads th ON th.id = r.thread_id WHERE ${visible}
          AND ${notOwn(sql, botId, filter.exclude_own, sql`r.turn_id`)} AND r.routed_to = 'human' AND r.created_at > now() - interval '7 days' LIMIT ${SAMPLE}`;
    case "pr.checks":
      return sql<Past>`SELECT n.created_at AS at, jsonb_build_object(
          'scope', jsonb_build_object('project', th.project_id, 'repository', n.body ->> 'repository',
            'pull_request', n.body ->> 'pull_request_id'),
          'fields', jsonb_build_object('event', n.body ->> 'event', 'reason', nullif(n.body ->> 'reason', ''),
            'failed_count', coalesce((n.body #>> '{counts,failed}')::int, 0),
            'automatic', coalesce((n.body ->> 'automatic')::boolean, false))) AS facts
        FROM pr_check_notes n JOIN threads th ON th.id = n.thread_id WHERE ${visible}
          AND ${notOwn(sql, botId, filter.exclude_own, sql`NULL::uuid`)} AND n.created_at > now() - interval '7 days' LIMIT ${SAMPLE}`;
    default:
      return sql<Past>`SELECT coalesce(t.completed_at, r.created_at) AS at, jsonb_build_object(
          'scope', jsonb_build_object('schedule', r.schedule_id, 'project', p.id),
          'fields', jsonb_build_object('phase', CASE WHEN r.outcome = 'expired' THEN 'expired'
            WHEN r.outcome = 'started' THEN 'finished' ELSE 'skipped' END, 'status', t.status)) AS facts
        FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id JOIN projects p ON p.id = s.project_id
        LEFT JOIN turns t ON t.id = r.turn_id LEFT JOIN threads th ON th.id = coalesce(t.thread_id, s.thread_id)
        WHERE p.owner_user_id = ${owner}::uuid AND s.memory_audience NOT LIKE 'conversation:%'
          AND (th.id IS NULL OR th.memory_audience NOT LIKE 'conversation:%')
          AND ${notOwn(sql, botId, filter.exclude_own, sql`t.id`)}
          AND coalesce(t.completed_at, r.created_at) > now() - interval '7 days'
          AND (r.outcome <> 'started' OR t.status IN ('completed','failed','interrupted')) LIMIT ${SAMPLE}`;
  }
}

export interface TriggerEstimate {
  /** False when the source keeps no full 7 days of history for this event type, or the sample was cut. */
  complete: boolean;
  matched: number;
  runs: number;
  busiestDay: number;
}

/** The table and time column each event type reads its history from. */
function historySource(event: string): readonly [string, string] {
  switch (event) {
    case "thread.needs_input":
      return ["interaction_requests", "created_at"];
    case "pr.checks":
      return ["pr_check_notes", "created_at"];
    case "schedule.run":
      return ["schedule_runs", "created_at"];
    default:
      return ["turns", "queued_at"];
  }
}

/** Whether the source kept facts for the whole window: a new installation has no 7 days to look back on. */
function covered(sql: SqlClient.SqlClient, owner: string, event: string) {
  const [table, at] = historySource(event);

  const owned =
    event === "schedule.run"
      ? sql`EXISTS (SELECT 1 FROM schedules s JOIN projects p ON p.id = s.project_id
          WHERE s.id = x.schedule_id AND p.owner_user_id = ${owner}::uuid)`
      : sql`EXISTS (SELECT 1 FROM threads th WHERE th.id = x.thread_id AND th.owner_user_id = ${owner}::uuid)`;

  return sql<{ covered: boolean }>`SELECT EXISTS (SELECT 1 FROM ${sql.literal(table)} x
    WHERE x.${sql.literal(at)} <= now() - interval '7 days' AND ${owned}) AS covered`.pipe(
    Effect.map((rows) => rows[0]?.covered === true),
  );
}

/** How often the trigger would have run over the last 7 days. Without full history it says so, never zero. */
export function estimateTrigger(
  sql: SqlClient.SqlClient,
  owner: string,
  botId: string,
  event: string,
  filter: TriggerFilter,
) {
  return Effect.gen(function* () {
    if (!eventType(event)?.history || !(yield* covered(sql, owner, event)))
      return { complete: false, matched: 0, runs: 0, busiestDay: 0 } satisfies TriggerEstimate;

    const rows = yield* history(sql, owner, botId, event, filter);

    const times = rows
      .filter((row) => matchesTrigger(filter, row.facts, event))
      .map((row) => new Date(row.at).getTime());

    return { complete: rows.length < SAMPLE, ...estimateRuns(times, filter) } satisfies TriggerEstimate;
  });
}

/** The owner confirms a trigger that could run often, or whose frequency cannot be estimated. */
export const needsTriggerCard = (estimate: TriggerEstimate) => !estimate.complete || estimate.busiestDay > 10;

export function estimateText(estimate: TriggerEstimate) {
  if (!estimate.complete) return "No full history for this event type: how often it runs cannot be estimated.";

  return `Over the last 7 days: ${estimate.matched} matching events, ${estimate.runs} runs, at most ${estimate.busiestDay} in one day.`;
}
