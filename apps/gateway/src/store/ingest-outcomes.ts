import type { ThreadEvent } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { accountThreadUsage } from "../usage/accounting.ts";
import { storageEvent } from "./event-text.ts";

export interface IngestOutcome {
  threadId: string;
  kind: "dropped" | "quarantined";
  reason: "deleted_thread" | "archived_thread" | "data_error" | "retry_exhausted";
  count: number;
}

export interface IngestFallback {
  code: string;
  reason: "data_error" | "archived_thread" | "retry_exhausted";
}

/** The lifecycle lock fences this cursor with archive/delete. No deleted content is retained. */
export const acknowledgeEvents = (
  sql: SqlClient.SqlClient,
  workerId: string,
  journalId: string,
  threadId: string,
  events: readonly ThreadEvent[],
) =>
  Effect.gen(function* () {
    const ack = events.reduce((max, e) => (e.journalSeq > max ? e.journalSeq : max), 0n);
    yield* sql`
      INSERT INTO worker_journal_cursors (worker_id, journal_id, thread_id, acked_seq)
      VALUES (${workerId}::uuid, ${journalId}, ${threadId}::uuid, ${ack})
      ON CONFLICT (worker_id, journal_id, thread_id) DO UPDATE SET acked_seq = greatest(worker_journal_cursors.acked_seq, EXCLUDED.acked_seq)
    `;

    return ack;
  });

export function acknowledgeDeleted(
  sql: SqlClient.SqlClient,
  workerId: string,
  journalId: string,
  threadId: string,
  events: readonly ThreadEvent[],
  origin: "worker" | "gateway",
) {
  return Effect.gen(function* () {
    if (origin === "worker") {
      for (const event of events) yield* accountThreadUsage(sql, threadId, storageEvent(event));
    }

    const previous = yield* sql<{ acked_seq: string }>`SELECT acked_seq FROM worker_journal_cursors
      WHERE worker_id=${workerId}::uuid AND journal_id=${journalId} AND thread_id=${threadId}::uuid`;

    const count = events.filter((event) => event.journalSeq > BigInt(previous[0]?.acked_seq ?? 0)).length;
    const ack = yield* acknowledgeEvents(sql, workerId, journalId, threadId, events);
    const outcomes: IngestOutcome[] = count ? [{ threadId, kind: "dropped", reason: "deleted_thread", count }] : [];

    return { ack, stored: [], outcomes };
  });
}

/** An archive retains history, but cannot create a new provider turn through replay. */
export const archivedEventAllowed = (sql: SqlClient.SqlClient, event: ThreadEvent) =>
  Effect.gen(function* () {
    if (!event.turnId) return event.body.case !== "turnStarted";

    const turns = yield* sql`SELECT 1 FROM turns WHERE id=${event.turnId}::uuid AND thread_id=${event.threadId}::uuid`;

    return turns.length > 0;
  });
