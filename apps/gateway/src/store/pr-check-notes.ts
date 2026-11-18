import { lockedOwnerModule, ownerModule } from "./module-access.ts";
import { PrChecksNote, prChecksNoteText } from "@canopy/domain";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { TurnRow } from "./rows.ts";
import { DISPATCHED, steerTarget } from "./turn-select.ts";

/**
 * Delivery of CI check notes (docs/agent-bus.md, "Checki CI"), like background task notes (store/background-tasks.ts):
 * waiting notes of a thread are merged into one platform note, steered into the running turn (turn_steers without an
 * author, background_note) or queued as a turn of their own (trigger pr_checks, the highest hops of the notes).
 * A note that may not wake the thread (hop limit) waits for the next turn that runs. The turn's and steer's input
 * carry the notes (sourceKind pr_checks, prChecks) for the timeline, so no other table is joined to show them.
 */

/** What deliver() did. */
export interface CheckNoteDelivery {
  /** A turn of its own was queued (start it). */
  readonly turn?: TurnRow;
  /** A steer of the running turn was stored (send it). */
  readonly steerId?: string;
  /** Notes cancelled with their closed thread. */
  readonly cancelled: number;
}

interface NoteRow {
  id: string;
  body: Schema.Json;
  wake: boolean;
  hops: number;
}

const decodeNote = Schema.decodeUnknownSync(PrChecksNote);

export const deliverCheckNotes = (sql: SqlClient.SqlClient, owner: string, threadId: string) =>
  sql.withTransaction(
    Effect.gen(function* () {
      // Most turn starts have no CI notes. Take the module and thread locks only for a pending delivery.
      if (
        !(yield* sql`SELECT 1 FROM pr_check_notes WHERE thread_id=${threadId}::uuid AND status='waiting' LIMIT 1`)
          .length ||
        !(yield* lockedOwnerModule(sql, owner, "threads"))
      )
        return { cancelled: 0 };

      // Lifecycle changes take the thread lock first, then settle their pending deliveries.
      const thread = (yield* sql<{ closed: boolean }>`
        SELECT (archived_at IS NOT NULL OR deleted_at IS NOT NULL) AS closed FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${owner}::uuid FOR UPDATE`)[0];

      if (!thread) return { cancelled: 0 };

      const notes = yield* sql<NoteRow>`
        SELECT id, body, wake, hops FROM pr_check_notes
         WHERE thread_id = ${threadId}::uuid AND status = 'waiting'
         ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED`;

      if (notes.length === 0) return { cancelled: 0 } satisfies CheckNoteDelivery;

      if (thread.closed) {
        yield* sql`UPDATE pr_check_notes SET status = 'cancelled', reason = 'the thread is archived or deleted', updated_at = now()
                    WHERE id = ANY(${notes.map((n) => n.id)}::uuid[])`;

        return { cancelled: notes.length } satisfies CheckNoteDelivery;
      }

      // A dispatched StartTurn owns the thread even before turn_started reaches the gateway.
      const running = yield* steerTarget(sql, threadId);
      const ready = notes.filter((note) => running || note.wake);

      // A dispatched start cannot accept a steer yet: the notes wait for turn_started (or the next tick).
      if (ready.length === 0 || running?.status === "queued") return { cancelled: 0 } satisfies CheckNoteDelivery;

      const bodies = ready.map((note) => decodeNote(note.body));
      const note = prChecksNoteText(bodies);
      const input = JSON.stringify({ text: note, note, message: "", sourceKind: "pr_checks", prChecks: bodies });
      const ids = ready.map((n) => n.id);
      const hops = Math.max(...ready.map((n) => n.hops));

      if (running) {
        const steerId = Bun.randomUUIDv7();
        yield* sql`
          INSERT INTO turn_steers (id, thread_id, turn_id, input, hops, background_note)
          VALUES (${steerId}::uuid, ${threadId}::uuid, ${running.id}::uuid, ${input}::jsonb, ${hops}, true)`;
        yield* sql`
          UPDATE pr_check_notes SET status = 'steering', steer_id = ${steerId}::uuid, updated_at = now()
           WHERE id = ANY(${ids}::uuid[])`;

        return { steerId, cancelled: 0 } satisfies CheckNoteDelivery;
      }

      const turn = (yield* sql<TurnRow>`
        INSERT INTO turns (id, thread_id, ordinal, trigger, hops, input)
        SELECT ${Bun.randomUUIDv7()}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'pr_checks', ${hops}, ${input}::jsonb
          FROM turns WHERE thread_id = ${threadId}::uuid
        RETURNING *`)[0]!;

      yield* sql`
        UPDATE pr_check_notes SET status = 'delivered', turn_id = ${turn.id}::uuid, updated_at = now()
         WHERE id = ANY(${ids}::uuid[])`;

      return { turn, cancelled: 0 } satisfies CheckNoteDelivery;
    }),
  );

/** Threads with notes deliver may move now, and note turns committed before their dispatch (a restart in between). */
export const pendingCheckNoteThreads = (sql: SqlClient.SqlClient, owner: string) =>
  sql<{ thread_id: string }>`
      SELECT DISTINCT n.thread_id FROM pr_check_notes n JOIN threads t ON t.id = n.thread_id
       WHERE t.owner_user_id = ${owner}::uuid AND ${ownerModule(sql, owner, "threads")} AND n.status = 'waiting'
         AND (n.wake OR EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = n.thread_id AND r.status = 'running'))
      UNION
      SELECT u.thread_id FROM turns u JOIN threads t ON t.id = u.thread_id
       WHERE t.owner_user_id = ${owner}::uuid AND ${ownerModule(sql, owner, "threads")} AND u.trigger = 'pr_checks' AND u.status = 'queued'
         AND t.archived_at IS NULL AND t.deleted_at IS NULL AND NOT ${sql.literal(DISPATCHED)}`.pipe(
    Effect.map((rows) => rows.map((r) => r.thread_id)),
  );

/** Closed threads: their watches end and undelivered notes are dropped (with the background notes). */
export const closeCheckWatches = (sql: SqlClient.SqlClient, threadIds: readonly string[]) =>
  Effect.gen(function* () {
    yield* sql`UPDATE pr_check_notes SET status = 'cancelled', steer_id = NULL, reason = 'thread closed', updated_at = now()
      WHERE thread_id = ANY(${threadIds}::uuid[]) AND status IN ('waiting', 'steering')`;
    yield* sql`UPDATE pr_check_watches SET status = 'ended', end_reason = 'thread_closed', ended_at = now(), updated_at = now()
      WHERE thread_id = ANY(${threadIds}::uuid[]) AND status = 'active'`;
  });

/** A note steer that did not join its turn (its steer was already failed by the background notes' release). */
export const releaseCheckNotes = (sql: SqlClient.SqlClient, steerId: string) =>
  sql<{ id: string }>`
    UPDATE pr_check_notes SET status = 'waiting', steer_id = NULL, updated_at = now()
     WHERE steer_id = ${steerId}::uuid AND status = 'steering'
    RETURNING id`.pipe(Effect.map((rows) => rows.length > 0));
