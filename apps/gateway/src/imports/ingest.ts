import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { ImportPage, ImportedTurn } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { applyItem, insertEvent } from "../store/ingest-events.ts";
import { importTransaction } from "./locks.ts";
import type { ItemRow } from "./store.ts";
import { fenceItem } from "./transitions.ts";

/**
 * Writing an imported thread (docs/import.md, "Zapis"): the thread is created once per item with the source's times
 * and placement, in the same transaction as its import mark and the item's link to it; then each page is one
 * transaction: its turns (trigger import, the source's times), their item events through the timeline's own reducer,
 * the thread's last_seq and the item's cursor. A page read again (retry, restart) carries the same turn and event
 * ids: nothing is duplicated. A stored turn read again (the last turn, when turns the CLI added are imported) gets
 * only the events it did not have, and its end.
 */

const at = (value: ImportedTurn["startedAt"]) => (value ? new Date(timestampMs(value)) : null);

/** The item's thread, created with its import mark and link in one transaction (the item is locked). */
export const ensureThread = (sql: SqlClient.SqlClient, item: ItemRow, startedAt: Date | null) =>
  importTransaction(sql, { items: [item.id] }, (locks) =>
    Effect.gen(function* () {
      yield* fenceItem(locks, item.id);
      const threadId = locks.items.get(item.id)?.thread_id;

      if (threadId) return threadId;

      return yield* createThread(sql, item, startedAt);
    }),
  );

const createThread = (sql: SqlClient.SqlClient, item: ItemRow, startedAt: Date | null) =>
  Effect.gen(function* () {
    const id = Bun.randomUUIDv7();
    const title = item.title || "Imported thread";
    yield* sql`
      INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, depth, runtime, provider, worker_id,
                           workspace_id, cwd, settings, status, title, title_source, created_at)
      VALUES (${id}::uuid, ${item.target.projectId}::uuid, ${item.owner_user_id}::uuid, 'main', ${id}::uuid, 0, 'worker',
              ${item.agent_cli}, ${item.worker_id}::uuid, ${item.target.workspaceId}::uuid, ${item.target.cwd},
              ${JSON.stringify({ permissionMode: "ASK" })}::jsonb, 'idle', ${title.slice(0, 200)},
              ${item.title ? "user" : "provisional"}, coalesce(${startedAt}::timestamptz, now()))`;
    yield* sql`
      INSERT INTO thread_imports (thread_id, owner_user_id, item_id, agent_cli, native_id, mode, source_cli_version)
      VALUES (${id}::uuid, ${item.owner_user_id}::uuid, ${item.id}::uuid, ${item.agent_cli}, ${item.native_id},
              ${item.target.mode}, ${item.target.cliVersion ?? ""})`;
    yield* sql`UPDATE import_items SET thread_id = ${id}::uuid, status = 'importing', updated_at = now() WHERE id = ${item.id}::uuid`;

    return id;
  });

function turnEnd(turn: ImportedTurn) {
  switch (turn.status) {
    case "failed":
      return { status: "failed", error: turn.error || "The CLI recorded an error", source: "harness", interrupt: null };
    case "interrupted":
      return { status: "interrupted", error: null, source: null, interrupt: "user" };
    default:
      return { status: "completed", error: null, source: null, interrupt: null };
  }
}

export const ingestPage = (sql: SqlClient.SqlClient, item: ItemRow, threadId: string, page: ImportPage) =>
  importTransaction(sql, { items: [item.id], threads: [threadId] }, (locks) =>
    Effect.gen(function* () {
      // A cancelled or undone run writes nothing more, even for a page that was on its way.
      yield* fenceItem(locks, item.id);

      const locked = yield* sql<{ last_seq: string; ordinal: number }>`
        SELECT t.last_seq, coalesce((SELECT max(ordinal) FROM turns WHERE thread_id = t.id), 0) AS ordinal
          FROM threads t WHERE t.id = ${threadId}::uuid`;

      if (!locks.threads.has(threadId) || !locked[0])
        return yield* Effect.fail(new Error("the imported thread is gone"));
      let seq = BigInt(locked[0].last_seq);
      let ordinal = Number(locked[0].ordinal);
      let added = 0;

      for (const turn of page.turns) {
        const end = turnEnd(turn);

        const inserted = yield* sql<{ id: string }>`
          INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, model, provider_turn_ref, error, error_source,
                             interrupt_source, queued_at, started_at, completed_at, first_seq, last_seq)
          VALUES (${turn.turnId}::uuid, ${threadId}::uuid, ${ordinal + 1}, ${end.status}, 'import',
                  ${JSON.stringify({ text: turn.prompt })}::jsonb, ${turn.model}, ${turn.providerTurnRef || null},
                  ${end.error}, ${end.source}, ${end.interrupt},
                  coalesce(${at(turn.startedAt)}::timestamptz, now()), ${at(turn.startedAt)}::timestamptz,
                  coalesce(${at(turn.completedAt)}::timestamptz, ${at(turn.startedAt)}::timestamptz),
                  ${seq + 1n}, ${seq + BigInt(turn.events.length)})
          ON CONFLICT (id) DO NOTHING RETURNING id`;

        if (inserted.length === 0) {
          seq = yield* reconcileTurn(sql, threadId, seq, turn);
          continue;
        }

        ordinal += 1;
        added += 1;

        for (const event of turn.events) {
          seq += 1n;
          yield* insertEvent(sql, threadId, seq, event, "worker");
          yield* applyItem(sql, threadId, seq, event);
        }
      }

      // The thread started when its CLI session did (the sidebar sorts it into the past, not to the top).
      yield* sql`UPDATE threads SET last_seq = ${seq}, updated_at = now(),
                        created_at = least(created_at, coalesce((SELECT min(started_at) FROM turns WHERE thread_id = ${threadId}::uuid), created_at))
                  WHERE id = ${threadId}::uuid`;

      if (page.title)
        yield* sql`UPDATE threads SET title = ${page.title.slice(0, 200)}, title_source = 'user'
                    WHERE id = ${threadId}::uuid AND title_source = 'provisional'`;
      yield* sql`
        UPDATE import_items SET cursor = ${page.nextCursor}, bytes_done = ${page.bytesRead}, turns = turns + ${added},
               warnings = (SELECT coalesce(jsonb_agg(DISTINCT w), '[]'::jsonb)
                             FROM jsonb_array_elements_text(warnings || ${JSON.stringify(page.warnings)}::jsonb) w),
               updated_at = now()
         WHERE id = ${item.id}::uuid`;
      // Imported history is not news: the owner has seen it.
      yield* sql`
        INSERT INTO thread_reads (user_id, thread_id, seen_seq) VALUES (${item.owner_user_id}::uuid, ${threadId}::uuid, ${seq})
        ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = greatest(thread_reads.seen_seq, EXCLUDED.seen_seq)`;

      return added;
    }),
  );

/**
 * A stored turn read again: the events it does not have yet (steps that changed since, new steps) are added at the
 * end of the thread, and the turn takes the end the source records now (its outcome, error and provider ref), also
 * when no step changed. Only the thread's last imported turn is read again, so the timeline stays in order.
 */
const reconcileTurn = (sql: SqlClient.SqlClient, threadId: string, from: bigint, turn: ImportedTurn) =>
  Effect.gen(function* () {
    const known = new Set(
      (yield* sql<{ event_id: string }>`
          SELECT event_id FROM thread_events WHERE thread_id = ${threadId}::uuid AND turn_id = ${turn.turnId}::uuid`).map(
        (r) => r.event_id,
      ),
    );

    const fresh = turn.events.filter(
      (e) => !known.has(e.eventId) && e.body.case !== "turnStarted" && e.body.case !== "turnFinished",
    );

    let seq = from;

    for (const event of fresh) {
      seq += 1n;
      yield* insertEvent(sql, threadId, seq, event, "worker");
      yield* applyItem(sql, threadId, seq, event);
    }

    const end = turnEnd(turn);
    yield* sql`
      UPDATE turns SET status = ${end.status}, error = ${end.error}, error_source = ${end.source},
             interrupt_source = ${end.interrupt}, provider_turn_ref = ${turn.providerTurnRef || null},
             model = coalesce(nullif(${turn.model}, ''), model),
             last_seq = coalesce(${fresh.length > 0 ? seq : null}::bigint, last_seq),
             completed_at = coalesce(${at(turn.completedAt)}::timestamptz, completed_at)
       WHERE id = ${turn.turnId}::uuid AND thread_id = ${threadId}::uuid AND trigger = 'import'`;

    return seq;
  });
