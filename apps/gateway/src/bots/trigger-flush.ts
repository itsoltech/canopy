import { DEFAULT_BUS_LIMITS } from "@canopy/domain";
import type { TriggerFilter } from "@canopy/domain/bot-triggers";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { lockedOwnerModule } from "../store/module-access.ts";
import { botActivityEvent } from "./activity-event.ts";
import type { BotCore } from "./store-queue.ts";
import { projections, stillCurrent, triggerInput } from "./trigger-current.ts";
import type { EventProjection } from "./trigger-matcher.ts";

/** A batch closes at this many matched events even before its quiet window ends. */
export const BATCH_MAX = 20;
const LIMIT_HOURS_TO_PAUSE = 3;
const RUNNING_RECHECK_SECONDS = 30;
const HOUR = 3_600_000;

export interface TriggerRow {
  id: string;
  bot_id: string;
  title: string;
  schedule_text: string;
  instructions: string;
  revision: number;
  filter: TriggerFilter;
  hops: number;
  live: boolean;
}

interface BatchRow {
  id: string;
  trigger_id: string;
  revision: number;
  matched: number;
  events: readonly EventProjection[];
  hops: number;
}

const close = (sql: SqlClient.SqlClient, id: string, status: "delivered" | "dropped", reason: string, now: Date) =>
  sql`UPDATE bot_trigger_batches SET status = ${status}, reason = ${reason}, closed_at = ${now}, check_after = NULL
    WHERE id = ${id}::uuid`;

/**
 * Counts a clock hour (of `now`) in which the trigger was held at its turn limit; the third consecutive one pauses
 * it. Runs between those hours do not reset the count: a steady flood keeps hitting the limit every hour.
 */
function limitHit(sql: SqlClient.SqlClient, trigger: TriggerRow, batch: BatchRow, now: Date) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{ paused: boolean }>`UPDATE bot_routines SET
      limit_hits = CASE WHEN limit_hour = date_trunc('hour', ${now}::timestamptz) THEN limit_hits
        WHEN limit_hour = date_trunc('hour', ${now}::timestamptz) - interval '1 hour' THEN limit_hits + 1 ELSE 1 END,
      limit_hour = date_trunc('hour', ${now}::timestamptz) WHERE id = ${trigger.id}::uuid
      RETURNING limit_hits >= ${LIMIT_HOURS_TO_PAUSE} AS paused`;

    if (!row?.paused) return false;
    yield* sql`UPDATE bot_routines SET auto_paused = true, revision = revision + 1, last_outcome = 'Paused: it fired too often',
      updated_at = now() WHERE id = ${trigger.id}::uuid`;
    yield* sql`DELETE FROM bot_trigger_scopes WHERE trigger_id = ${trigger.id}::uuid`;
    yield* close(sql, batch.id, "dropped", "Trigger paused", now);

    const [last] = yield* sql<{ id: string }>`SELECT id FROM bot_turns WHERE routine_id = ${trigger.id}::uuid
      ORDER BY created_at DESC, id DESC LIMIT 1`;

    if (last)
      yield* botActivityEvent(
        sql,
        trigger.bot_id,
        last.id,
        "trigger-paused",
        `Paused trigger “${trigger.title}”: it fired too often`,
      );

    return true;
  });
}

/** The batch with its trigger, locked in the order answers and edits use: module, bot, trigger, batch. */
function lockBatch(sql: SqlClient.SqlClient, owner: string, batchId: string) {
  return Effect.gen(function* () {
    if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return undefined;

    const [ref] = yield* sql<{ bot_id: string; trigger_id: string }>`SELECT r.bot_id, x.trigger_id
      FROM bot_trigger_batches x JOIN bot_routines r ON r.id = x.trigger_id WHERE x.id = ${batchId}::uuid`;

    if (!ref) return undefined;

    const bot = yield* sql`SELECT id FROM bots WHERE id = ${ref.bot_id}::uuid AND owner_user_id = ${owner}::uuid
      AND deleted_at IS NULL AND archived_at IS NULL AND moved_to IS NULL FOR UPDATE`;

    const [trigger] = yield* sql<TriggerRow>`SELECT id, bot_id, title, schedule_text, instructions, revision, filter,
        hops, (enabled AND NOT auto_paused AND deleted_at IS NULL) AS live
      FROM bot_routines WHERE id = ${ref.trigger_id}::uuid FOR UPDATE`;

    const [batch] = yield* sql<BatchRow & { events: unknown }>`SELECT id, trigger_id, revision, matched, events, hops
      FROM bot_trigger_batches WHERE id = ${batchId}::uuid AND status = 'open' FOR UPDATE`;

    if (!bot.length || !trigger || !batch) return undefined;

    return { trigger, batch: { ...batch, events: projections(batch.events) } };
  });
}

/**
 * One due batch, read again under its locks: dropped, held (for a running turn or a free hourly slot, rechecked
 * then), or turned into one background run.
 */
function flushBatch(
  sql: SqlClient.SqlClient,
  core: Pick<BotCore, "enqueue" | "changed">,
  owner: string,
  batchId: string,
  now: Date,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const locked = yield* lockBatch(sql, owner, batchId);

      if (!locked) return undefined;
      const { trigger, batch } = locked;

      if (!trigger.live || trigger.revision !== batch.revision)
        return yield* close(sql, batch.id, "dropped", "Trigger changed", now);

      const running = yield* sql`SELECT 1 FROM bot_turns WHERE routine_id = ${trigger.id}::uuid
        AND status IN ('queued','running','waiting')`;

      if (running.length)
        return yield* sql`UPDATE bot_trigger_batches SET
          check_after = ${now}::timestamptz + make_interval(secs => ${RUNNING_RECHECK_SECONDS}) WHERE id = ${batch.id}::uuid`;

      const recent = yield* sql<{ closed_at: Date }>`SELECT closed_at FROM bot_trigger_batches
        WHERE trigger_id = ${trigger.id}::uuid AND status = 'delivered'
          AND closed_at > ${now}::timestamptz - interval '1 hour' ORDER BY closed_at`;

      const limit = trigger.filter.max_turns_per_hour;

      if (recent.length >= limit) {
        if (yield* limitHit(sql, trigger, batch, now)) return;
        const free = new Date(new Date(recent[recent.length - limit]!.closed_at).getTime() + HOUR);

        return yield* sql`UPDATE bot_trigger_batches SET check_after = ${free} WHERE id = ${batch.id}::uuid`;
      }

      const events = yield* stillCurrent(sql, owner, batch.events, now);

      if (!events.length) return yield* close(sql, batch.id, "dropped", "Nothing left to report", now);
      const hops = Math.max(trigger.hops, batch.hops + 1);

      if (hops > DEFAULT_BUS_LIMITS.maxHops) return yield* close(sql, batch.id, "dropped", "Hop limit reached", now);

      const turn = yield* core.enqueue(
        owner,
        trigger.bot_id,
        triggerInput(trigger, batch.matched, events),
        `trigger:${trigger.id}:${batch.id}`,
        { hops, sender: "system", event: true, routineId: trigger.id, routineTitle: trigger.title },
      );

      yield* close(sql, batch.id, "delivered", "", now);
      yield* sql`UPDATE bot_trigger_batches SET turn_id = ${turn}::uuid, snapshot = ${JSON.stringify({
        title: trigger.title,
        schedule_text: trigger.schedule_text,
        instructions: trigger.instructions,
      })}::jsonb WHERE id = ${batch.id}::uuid`;
      yield* sql`UPDATE bot_routines SET last_run_at = now(), run_count = run_count + 1, last_outcome = 'Running',
        updated_at = now() WHERE id = ${trigger.id}::uuid`;
      yield* core.changed(trigger.bot_id);

      return turn;
    }),
  );
}

/** Closes due batches (quiet window passed or full, and not held) and prunes old ones; `now` drives the clock. */
export function flushTriggerBatches(
  sql: SqlClient.SqlClient,
  core: Pick<BotCore, "enqueue" | "changed">,
  owner: string,
  now: Date,
) {
  return Effect.gen(function* () {
    yield* sql`UPDATE bot_trigger_batches x SET status = 'dropped', reason = 'Expired', closed_at = ${now}, check_after = NULL
      FROM bot_routines r JOIN bots b ON b.id = r.bot_id WHERE r.id = x.trigger_id AND b.owner_user_id = ${owner}::uuid
        AND x.status = 'open' AND x.opened_at < ${now}::timestamptz - interval '24 hours'`;
    // A delivered batch stays while its run waits: the run reads its events when it starts.
    yield* sql`DELETE FROM bot_trigger_batches x USING bot_routines r, bots b WHERE r.id = x.trigger_id
      AND b.id = r.bot_id AND b.owner_user_id = ${owner}::uuid AND x.status <> 'open'
      AND x.closed_at < ${now}::timestamptz - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM bot_turns t WHERE t.id = x.turn_id AND t.status IN ('queued','running','waiting'))`;
    yield* sql`DELETE FROM bot_trigger_receipts x USING bot_routines r, bots b WHERE r.id = x.trigger_id
      AND b.id = r.bot_id AND b.owner_user_id = ${owner}::uuid
      AND (x.revision <> r.revision OR x.expires_at < ${now}::timestamptz)`;

    const due = yield* sql<{ id: string }>`SELECT x.id FROM bot_trigger_batches x
        JOIN bot_routines r ON r.id = x.trigger_id JOIN bots b ON b.id = r.bot_id
      WHERE b.owner_user_id = ${owner}::uuid AND x.status = 'open' AND b.deleted_at IS NULL AND b.archived_at IS NULL
        AND b.moved_to IS NULL AND (x.check_after IS NULL OR x.check_after <= ${now}::timestamptz)
        AND (x.matched >= ${BATCH_MAX}
          OR x.opened_at + make_interval(secs => (r.filter->>'coalesce_seconds')::int) <= ${now}::timestamptz)
      ORDER BY coalesce(x.check_after, x.opened_at), x.id LIMIT 50`;

    for (const row of due) yield* flushBatch(sql, core, owner, row.id, now);

    return due.length;
  });
}
