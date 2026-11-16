import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { TestGateway } from "./gateway.ts";

export const storageQuery = <T extends object>(gateway: TestGateway, sql: string, args: readonly unknown[] = []) =>
  gateway.core.linkedAgents.query<T>(sql, [...args]);

/** The normal update trigger refreshes this timestamp; bypass only inside this isolated fixture transaction. */
export const ageSettledThread = (gateway: TestGateway, threadId: string) =>
  gateway.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL session_replication_role='replica'`;
          yield* sql`UPDATE threads SET updated_at=now()-interval '2 hours' WHERE id=${threadId}::uuid`;
        }),
      );
    }),
  );

/** Row/JSON bytes belong to this thread. Whole-table relation bytes include indexes, TOAST and dead space. */
export async function storageSizes(gateway: TestGateway, threadId: string) {
  const tables = [
    "thread_events",
    "thread_items",
    "thread_replication_journal",
    "thread_replication_content",
    "worker_commands",
  ];

  const sizes = [];

  for (const table of tables) {
    const [row] = await storageQuery<{
      rows: number;
      row_bytes: number;
      logical_json_bytes: number;
      relation_bytes: number;
    }>(
      gateway,
      `SELECT count(*)::int AS rows, coalesce(sum(pg_column_size(t)),0)::float8 AS row_bytes,
      coalesce(sum(octet_length(to_jsonb(t)::text)),0)::float8 AS logical_json_bytes,
      pg_total_relation_size($2::regclass)::float8 AS relation_bytes FROM ${table} t WHERE thread_id=$1::uuid`,
      [threadId, table],
    );

    sizes.push({ table, ...row });
  }

  const [blobs] = await storageQuery<{
    rows: number;
    row_bytes: number;
    logical_data_bytes: number;
    relation_bytes: number;
  }>(
    gateway,
    `SELECT count(*)::int AS rows,coalesce(sum(pg_column_size(b)),0)::float8 AS row_bytes,
    coalesce(sum(octet_length(data)),0)::float8 AS logical_data_bytes,
    pg_total_relation_size('blobs')::float8 AS relation_bytes FROM blobs b WHERE sha256 IN (
      SELECT sha256 FROM thread_blobs WHERE thread_id=$1::uuid
      UNION SELECT sha256 FROM attachments WHERE thread_id=$1::uuid
      UNION SELECT thumb_sha256 FROM attachments WHERE thread_id=$1::uuid)`,
    [threadId],
  );

  sizes.push({ table: "blobs", ...blobs });

  const [eventColumns] = await storageQuery<{
    raw_stored_bytes: number;
    raw_json_bytes: number;
    raw_refs_stored_bytes: number;
    raw_refs_json_bytes: number;
    payload_stored_bytes: number;
    payload_json_bytes: number;
  }>(
    gateway,
    `SELECT coalesce(sum(pg_column_size(raw)),0)::float8 AS raw_stored_bytes,
    coalesce(sum(octet_length(raw::text)),0)::float8 AS raw_json_bytes,
    coalesce(sum(pg_column_size(raw_payload_refs)),0)::float8 AS raw_refs_stored_bytes,
    coalesce(sum(octet_length(raw_payload_refs::text)),0)::float8 AS raw_refs_json_bytes,
    coalesce(sum(pg_column_size(payload)),0)::float8 AS payload_stored_bytes,
    coalesce(sum(octet_length(payload::text)),0)::float8 AS payload_json_bytes
    FROM thread_events WHERE thread_id=$1::uuid`,
    [threadId],
  );

  sizes.push({ table: "thread_events_columns", ...eventColumns });

  return sizes;
}

export async function projectedDigest(gateway: TestGateway, threadId: string) {
  const rows = await storageQuery<{ item_id: string; type: string; status: string; content: object }>(
    gateway,
    "SELECT item_id,type,status,content FROM thread_items WHERE thread_id=$1::uuid ORDER BY first_seq,item_id",
    [threadId],
  );

  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** Compute in PostgreSQL so provider envelopes never appear in test output. */
export async function rawContents(gateway: TestGateway, threadId: string, throughSeq: string | null = null) {
  const [result] = await storageQuery<{ digest: string; reconstructed_json_bytes: number; through_seq: string }>(
    gateway,
    `WITH restored AS (
      SELECT seq,thread_event_raw(raw,payload,raw_payload_refs) AS raw FROM thread_events
      WHERE thread_id=$1::uuid AND ($2::bigint IS NULL OR seq<=$2::bigint)
    ) SELECT md5(coalesce(string_agg(jsonb_build_array(seq,raw)::text,E'\\n' ORDER BY seq),'')) AS digest,
      coalesce(max(seq),0)::text AS through_seq,
      coalesce(sum(octet_length(raw::text)),0)::float8 AS reconstructed_json_bytes FROM restored`,
    [threadId, throughSeq],
  );

  if (!result) throw new Error("Missing raw transcript digest");

  return result;
}
