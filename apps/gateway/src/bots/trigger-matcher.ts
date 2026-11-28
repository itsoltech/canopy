import { matchesTrigger, type EventFacts, type TriggerFilter } from "@canopy/domain/bot-triggers";
import { Effect, Predicate, Schema } from "effect";
import { lockedOwnerModule } from "../store/module-access.ts";
import type { SqlClient } from "effect/sql";
import { uuid } from "./store-views.ts";

export const BATCH_KEEP = 50;

interface EventRow {
  id: string;
  event: string;
  occurrence: string;
  facts: EventFacts;
  context: Record<string, string | null>;
  candidates: { id: string; revision: number }[];
  hops: number;
  created_at: Date;
}

interface CandidateRow {
  id: string;
  bot_id: string;
  revision: number;
  filter: TriggerFilter;
  /** When the revision last changed, in epoch seconds. */
  since: number;
}

/** What a batch keeps of a matched event: catalogue fields, resources with names, and source ids. */
export interface EventProjection {
  event: string;
  at: string;
  fields: Readonly<EventFacts["fields"]>;
  resources: readonly { readonly kind: string; readonly id: string; readonly name: string }[];
  context: Readonly<Record<string, string>>;
}

const Projections = Schema.Array(Schema.Unknown);
const isList = Schema.is(Projections);

/** Names of an event's resources, read through the owner's tables at match time. */
function names(sql: SqlClient.SqlClient, owner: string, facts: EventFacts) {
  const ids = facts.scope;

  return sql<{ kind: string; id: string; name: string }>`
    SELECT 'project' AS kind, id::text, name FROM projects WHERE id::text = ${ids.project ?? ""} AND owner_user_id = ${owner}::uuid
    UNION ALL SELECT 'worker', id::text, name FROM workers WHERE id::text = ${ids.worker ?? ""}
    UNION ALL SELECT 'thread', id::text, coalesce(nullif(title, ''), 'Untitled thread') FROM threads
      WHERE id::text = ${ids.thread ?? ""} AND owner_user_id = ${owner}::uuid
    UNION ALL SELECT 'schedule', s.id::text, coalesce(nullif(s.name, ''), 'Schedule') FROM schedules s
      WHERE s.id::text = ${ids.schedule ?? ""}
    UNION ALL SELECT 'pull_request', id::text, repository_name || ' #' || number FROM github_pull_requests
      WHERE id::text = ${ids.pull_request ?? ""} AND owner_user_id = ${owner}::uuid
    UNION ALL SELECT 'repository', ${ids.repository ?? ""}, ${ids.repository ?? ""} WHERE ${ids.repository ?? ""} <> ''
    UNION ALL SELECT 'profile', harness || '/' || id, label FROM provider_instances
      WHERE harness || '/' || id = ${ids.profile ?? ""} AND (created_by = ${owner}::uuid OR created_by IS NULL)`;
}

/** Every resource of the event with its name; a resource gone since keeps its id, and is checked again later. */
function resources(sql: SqlClient.SqlClient, owner: string, facts: EventFacts) {
  return names(sql, owner, facts).pipe(
    Effect.map((rows) =>
      Object.entries(facts.scope).flatMap(([kind, id]) =>
        Predicate.isString(id) && id
          ? [{ kind, id, name: rows.find((r) => r.kind === kind && r.id === id)?.name ?? id }]
          : [],
      ),
    ),
  );
}

/**
 * The trigger's own work and turns it already hears about never wake it: a turn it watches (its report covers it,
 * delivered or not), and unless the filter opts in, an input or steer from this bot or a thread it started.
 */
function ownWork(sql: SqlClient.SqlClient, botId: string, context: EventRow["context"], excludeOwn: boolean) {
  const thread = context["thread_id"] ?? null;
  const turn = context["turn_id"] ?? null;
  const call = context["bot_call_id"] ?? null;

  if (!thread) return Effect.succeed(false);

  return sql<{ own: boolean }>`SELECT
    EXISTS (SELECT 1 FROM bot_thread_watches w WHERE w.bot_id = ${botId}::uuid AND w.target_thread_id = ${thread}::uuid
      AND w.target_turn_id = ${turn}::uuid)
    OR (${excludeOwn} AND (
      EXISTS (SELECT 1 FROM bot_started_threads s WHERE s.thread_id = ${thread}::uuid AND s.bot_id = ${botId}::uuid)
      OR EXISTS (SELECT 1 FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id
        WHERE c.id = ${call}::uuid AND t.bot_id = ${botId}::uuid)
      OR EXISTS (SELECT 1 FROM turn_steers s JOIN bot_tool_calls c ON c.id = s.bot_call_id JOIN bot_turns t ON t.id = c.turn_id
        WHERE s.thread_id = ${thread}::uuid AND s.turn_id = ${turn}::uuid AND t.bot_id = ${botId}::uuid
          AND s.status IN ('pending','accepted','delivered')))) AS own`.pipe(
    Effect.map((rows) => rows[0]?.own === true),
  );
}

/** Adds the projection to the trigger's open batch of this revision; a batch of an older revision is dropped. */
function addToBatch(
  sql: SqlClient.SqlClient,
  trigger: CandidateRow,
  projection: EventProjection,
  hops: number,
  now: Date,
) {
  return Effect.gen(function* () {
    const [open] = yield* sql<{ id: string; revision: number; events: unknown; hops: number }>`SELECT id, revision,
      events, hops FROM bot_trigger_batches WHERE trigger_id = ${trigger.id}::uuid AND status = 'open' FOR UPDATE`;

    if (open && open.revision === trigger.revision) {
      const events = [...(isList(open.events) ? open.events : []), projection].slice(-BATCH_KEEP);
      yield* sql`UPDATE bot_trigger_batches SET matched = matched + 1, events = ${JSON.stringify(events)}::jsonb,
        hops = greatest(hops, ${hops}) WHERE id = ${open.id}::uuid`;

      return;
    }

    if (open)
      yield* sql`UPDATE bot_trigger_batches SET status = 'dropped', reason = 'Trigger changed', closed_at = now()
        WHERE id = ${open.id}::uuid`;
    yield* sql`INSERT INTO bot_trigger_batches(id, trigger_id, revision, opened_at, matched, events, hops)
      VALUES (${uuid()}::uuid, ${trigger.id}::uuid, ${trigger.revision}, ${now}, 1, ${JSON.stringify([projection])}::jsonb, ${hops})`;
  });
}

/**
 * A fact a source reports once per trigger revision (`context.once`, e.g. a usage window and its reset): the first
 * match writes its receipt, kept apart from batch history; later ones are skipped, as is a window already reset.
 */
function reported(sql: SqlClient.SqlClient, trigger: CandidateRow, context: EventRow["context"], now: Date) {
  const once = context["once"];

  if (!once) return Effect.succeed(false);

  const until = Date.parse(context["resets_at"] ?? "");

  if (until <= now.getTime()) return Effect.succeed(true);

  return sql`INSERT INTO bot_trigger_receipts(trigger_id, revision, key, expires_at)
    VALUES (${trigger.id}::uuid, ${trigger.revision}, ${once}, ${Number.isNaN(until) ? null : new Date(until)})
    ON CONFLICT DO NOTHING RETURNING key`.pipe(Effect.map((rows) => rows.length === 0));
}

/** The candidates of these events that can still match, locked in one order so matchers never deadlock. */
function liveTriggers(sql: SqlClient.SqlClient, owner: string, events: readonly EventRow[]) {
  const ids = [...new Set(events.flatMap((event) => event.candidates.map((c) => c.id)))];

  return sql<CandidateRow & { event: string; frozen: boolean }>`SELECT r.id, r.bot_id, r.revision, r.filter, r.event,
      extract(epoch FROM r.revised_at)::float8 AS since, b.moved_to IS NOT NULL AS frozen FROM bot_routines r
    JOIN bots b ON b.id = r.bot_id WHERE r.id = ANY(${ids}::uuid[]) AND r.kind = 'trigger'
      AND r.enabled AND NOT r.auto_paused AND r.deleted_at IS NULL AND b.owner_user_id = ${owner}::uuid
      AND b.deleted_at IS NULL AND b.archived_at IS NULL
      -- A bot frozen by an undecided move keeps its events: a rollback matches them, a commit discards them.
      AND (b.moved_to IS NULL OR EXISTS (SELECT 1 FROM computer_moves m WHERE m.owner_user_id = b.owner_user_id
        AND m.kind = 'bot' AND m.item_id = b.id AND m.state IN ('preparing', 'prepared', 'aborting')))
    ORDER BY r.id FOR UPDATE OF r`;
}

/** One event against its live candidates; returns the frozen candidates it still waits for. */
function matchEvent(
  sql: SqlClient.SqlClient,
  owner: string,
  event: EventRow,
  live: readonly (CandidateRow & { event: string; frozen: boolean })[],
  now: Date,
) {
  return Effect.gen(function* () {
    const waiting: EventRow["candidates"] = [];

    for (const trigger of live) {
      const recorded = event.candidates.find((c) => c.id === trigger.id);

      if (trigger.event !== event.event || recorded?.revision !== trigger.revision) continue;

      if (trigger.frozen) {
        waiting.push(recorded);
        continue;
      }

      if (
        !matchesTrigger(trigger.filter, event.facts, event.event, trigger.since) ||
        (yield* ownWork(sql, trigger.bot_id, event.context, trigger.filter.exclude_own)) ||
        (yield* reported(sql, trigger, event.context, now))
      )
        continue;

      const context = Object.fromEntries(
        Object.entries(event.context).filter((entry): entry is [string, string] => Predicate.isString(entry[1])),
      );

      yield* addToBatch(
        sql,
        trigger,
        {
          event: event.event,
          at: new Date(event.created_at).toISOString(),
          fields: event.facts.fields,
          resources: yield* resources(sql, owner, event.facts),
          context,
        },
        event.hops,
        now,
      );
    }

    return waiting;
  });
}

/**
 * Matches the owner's recorded events, a portion per call. Only the triggers and revisions recorded with an event
 * are considered, so a trigger created or changed afterwards never receives it. Each event is removed once handled.
 * The module lock fences a transition: with Bots off, recorded events are discarded, and an event recorded before
 * the owner's latest transition (in a transaction that committed after it) never matches.
 */
export function matchTriggerEvents(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const enabled = yield* lockedOwnerModule(sql, owner, "bots");

      const [{ generation } = { generation: 0 }] = yield* sql<{ generation: number }>`SELECT coalesce(
        (SELECT g.generation FROM bot_trigger_generations g WHERE g.owner_user_id = ${owner}::uuid), 0)::float8 AS generation`;

      yield* sql`DELETE FROM bot_trigger_events WHERE owner_user_id = ${owner}::uuid AND generation < ${generation}`;

      // Only the current generation: an older writer may commit after the delete above.
      const events = yield* sql<EventRow>`SELECT * FROM bot_trigger_events WHERE owner_user_id = ${owner}::uuid
          AND generation = ${generation} AND (held_until IS NULL OR held_until <= now())
        ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED`;

      if (!enabled) {
        yield* sql`DELETE FROM bot_trigger_events WHERE id = ANY(${events.map((e) => e.id)}::uuid[])`;

        return 0;
      }

      const live = yield* liveTriggers(sql, owner, events);

      for (const event of events) {
        const waiting = yield* matchEvent(sql, owner, event, live, now);

        if (waiting.length)
          yield* sql`UPDATE bot_trigger_events SET candidates = ${JSON.stringify(waiting)}::jsonb,
            held_until = now() + interval '30 seconds' WHERE id = ${event.id}::uuid`;
        else yield* sql`DELETE FROM bot_trigger_events WHERE id = ${event.id}::uuid`;
      }

      return events.length;
    }),
  );
}
