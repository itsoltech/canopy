import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export const REPLICATION_GRACE_SECONDS = 3600;

/** Only freshly projected source records may update current-entity pointers;
 * replaying an old immutable record must not resurrect a superseded revision.
 */
export function retainCurrentContent(
  sql: SqlClient.SqlClient,
  thread: string,
  records: readonly ui.ThreadSyncRecord[],
) {
  return Effect.gen(function* () {
    const values = records.flatMap((record) => {
      const hash = contentHash(record);

      return hash ? [{ key: record.key, hash, seq: record.seq.toString() }] : [];
    });

    if (!values.length) return;
    yield* sql`INSERT INTO thread_replication_entity_content(thread_id,entity_key,sha256,seq)
      SELECT ${thread}::uuid,p.key,p.hash,p.seq FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
        p(key text,hash text,seq bigint)
      ON CONFLICT(thread_id,entity_key) DO UPDATE SET sha256=excluded.sha256,seq=excluded.seq`;
  });
}

export function contentHash(record: ui.ThreadSyncRecord) {
  return record.content?.sha256 || (record.value.case === "item" ? record.value.value.contentRef?.sha256 : undefined);
}

/** Publication leases outlive sockets and gateway restarts. A cached snapshot
 * must renew this lease before issuing the same references to another client.
 */
export function leaseRangeRecords(
  sql: SqlClient.SqlClient,
  thread: string,
  epoch: string,
  head: bigint,
  applied: bigint,
  records: readonly ui.ThreadSyncRecord[],
  generation: string = crypto.randomUUID(),
  kind: "range" | "snapshot" = "range",
) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO thread_replication_snapshot_generations
      (thread_id,generation,epoch,head_seq,applied_seq,kind,lease_until)
      VALUES(${thread}::uuid,${generation}::uuid,${epoch}::uuid,${head},${applied},${kind},now()+interval '1 hour')
      ON CONFLICT(thread_id,generation) DO UPDATE SET epoch=excluded.epoch,head_seq=excluded.head_seq,
        applied_seq=excluded.applied_seq,lease_until=excluded.lease_until`;

    const hashes = [
      ...new Set(
        records.flatMap((record) => {
          const hash = contentHash(record);

          return hash ? [hash] : [];
        }),
      ),
    ];

    if (!hashes.length) return 0;

    const existing = yield* sql<{ sha256: string }>`UPDATE thread_replication_content SET last_referenced_at=now()
      WHERE thread_id=${thread}::uuid AND sha256=ANY(${hashes}::text[]) RETURNING sha256`;

    yield* sql`INSERT INTO thread_replication_content_leases(thread_id,sha256,generation,lease_until)
      SELECT thread_id,sha256,${generation}::uuid,now()+interval '1 hour' FROM thread_replication_content
      WHERE thread_id=${thread}::uuid AND sha256=ANY(${hashes}::text[])
      ON CONFLICT(thread_id,sha256,generation) DO UPDATE SET lease_until=excluded.lease_until`;

    return existing.length;
  });
}
