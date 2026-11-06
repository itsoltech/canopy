import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ThreadEventSchema } from "@canopy/contracts";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { applyItem } from "../store/ingest-events.ts";

/**
 * Turns the CLI added after an import go into the same thread (docs/import.md, "Has new turns"). Such an item records
 * where the thread stood (`base`): its last event and the end of its last imported turn, which a re-read may change.
 * Cancelling or undoing the append puts the thread back exactly there and gives the earlier import its thread back,
 * so the history imported before stays as it was.
 */

export const AppendBase = Schema.Struct({
  seq: Schema.String,
  turn: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      error: Schema.NullOr(Schema.String),
      error_source: Schema.NullOr(Schema.String),
      interrupt_source: Schema.NullOr(Schema.String),
      provider_turn_ref: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      completed_at: Schema.NullOr(Schema.String),
      last_seq: Schema.NullOr(Schema.String),
    }),
  ),
});

export type AppendBase = typeof AppendBase.Type;

const decodeBase = Schema.decodeUnknownOption(AppendBase);

/** Where the thread stands before an append (its row is locked by the caller). */
export const appendBase = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const thread = yield* sql<{ last_seq: string }>`SELECT last_seq::text FROM threads WHERE id = ${threadId}::uuid`;

    const turn = yield* sql<NonNullable<AppendBase["turn"]>>`
      SELECT id::text, status, error, error_source, interrupt_source, provider_turn_ref, model,
             completed_at::text, last_seq::text
        FROM turns WHERE thread_id = ${threadId}::uuid AND trigger = 'import' ORDER BY ordinal DESC LIMIT 1`;

    return { seq: thread[0]?.last_seq ?? "0", turn: turn[0] ?? null } satisfies AppendBase;
  });

/** Undo of an append would remove more than the import wrote. */
export class ThreadContinued extends Error {
  constructor() {
    super("Can't undo: the thread continued after this import.");
  }
}

/**
 * Anything after the append's base that the import did not write: a turn of another kind, or an event outside the
 * import's turns.
 */
const continuedAfter = (sql: SqlClient.SqlClient, threadId: string, seq: string) =>
  Effect.gen(function* () {
    const found = yield* sql`
      SELECT 1 FROM thread_events e LEFT JOIN turns u ON u.id = e.turn_id AND u.thread_id = e.thread_id
       WHERE e.thread_id = ${threadId}::uuid AND e.seq > ${seq}::bigint AND (u.id IS NULL OR u.trigger <> 'import')
      UNION ALL
      SELECT 1 FROM turns WHERE thread_id = ${threadId}::uuid AND trigger <> 'import'
         AND (first_seq IS NULL OR first_seq > ${seq}::bigint)
      LIMIT 1`;

    return found.length > 0;
  });

/** The earlier import owns the thread again (its cursor and checkpoint are its own). */
export const restoreOwner = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`
    UPDATE import_items SET status = 'done', updated_at = now()
     WHERE id = (SELECT id FROM import_items WHERE thread_id = ${threadId}::uuid AND status = 'superseded'
                  ORDER BY updated_at DESC LIMIT 1)`;

/**
 * Removes what an append wrote after its base: its events, its new turns and what those events did to items (rebuilt
 * from the events that stay), restores the last turn's end, and returns the thread to the item it superseded. Runs in
 * an importTransaction that locked the append's run, the thread's items and the thread (locks.ts).
 */
export const revertAppend = (
  sql: SqlClient.SqlClient,
  item: { readonly id: string; readonly thread_id: string | null; readonly base: JsonValue | null },
) =>
  Effect.gen(function* () {
    const base = item.base === null ? undefined : Option.getOrUndefined(decodeBase(item.base));

    if (!item.thread_id || !base) return false;
    const threadId = item.thread_id;
    const { seq, turn } = base;

    // Never past what the import wrote: a thread that went on after the append keeps everything.
    if (yield* continuedAfter(sql, threadId, seq)) return yield* Effect.fail(new ThreadContinued());

    const touched = (yield* sql<{ item_id: string }>`
        SELECT DISTINCT item_id FROM thread_events
         WHERE thread_id = ${threadId}::uuid AND seq > ${seq}::bigint AND item_id IS NOT NULL`).map((r) => r.item_id);

    if (touched.length > 0)
      yield* sql`DELETE FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ANY(${touched})`;
    yield* sql`DELETE FROM thread_events WHERE thread_id = ${threadId}::uuid AND seq > ${seq}::bigint`;
    yield* sql`DELETE FROM turns WHERE thread_id = ${threadId}::uuid AND trigger = 'import' AND first_seq > ${seq}::bigint`;

    // Items the append changed are rebuilt from the events before it, with the timeline's own reducer.
    const kept = yield* sql<{ seq: string; payload: JsonValue }>`
      SELECT seq::text, payload FROM thread_events
       WHERE thread_id = ${threadId}::uuid AND item_id = ANY(${touched}) ORDER BY seq`;

    for (const event of kept)
      yield* applyItem(sql, threadId, BigInt(event.seq), fromJson(ThreadEventSchema, event.payload));

    if (turn)
      yield* sql`
        UPDATE turns SET status = ${turn.status}, error = ${turn.error}, error_source = ${turn.error_source},
               interrupt_source = ${turn.interrupt_source}, provider_turn_ref = ${turn.provider_turn_ref},
               model = ${turn.model}, completed_at = ${turn.completed_at}::timestamptz, last_seq = ${turn.last_seq}::bigint
         WHERE id = ${turn.id}::uuid AND thread_id = ${threadId}::uuid`;
    yield* sql`UPDATE threads SET last_seq = ${seq}::bigint, updated_at = now() WHERE id = ${threadId}::uuid`;
    yield* sql`UPDATE thread_reads SET seen_seq = least(seen_seq, ${seq}::bigint) WHERE thread_id = ${threadId}::uuid`;
    // The import this one continued owns the thread again, with its own cursor.
    yield* restoreOwner(sql, threadId);

    return true;
  });

/**
 * A native thread that can no longer resume its copy: history, continued in a new thread, with the reason. In an
 * importTransaction that locked the thread (and so its items).
 */
export const toHistory = (sql: SqlClient.SqlClient, threadId: string, reason: string) =>
  Effect.gen(function* () {
    const changed = yield* sql`
      UPDATE thread_imports SET mode = 'history' WHERE thread_id = ${threadId}::uuid AND mode = 'native' RETURNING thread_id`;

    if (changed.length > 0)
      yield* sql`
        UPDATE import_items SET warnings = warnings || ${JSON.stringify([reason])}::jsonb,
               target = jsonb_set(target, '{mode}', '"history"')
         WHERE id = (SELECT item_id FROM thread_imports WHERE thread_id = ${threadId}::uuid)`;
  });
