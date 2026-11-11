import { fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { packThreadBatch, THREAD_BATCH_BYTES } from "@canopy/domain/thread-sync";
import { Code, ConnectError } from "@connectrpc/connect";
import type { SqlClient } from "effect/sql";
import type { RangeKey } from "./range-projection.ts";

export type RangeHead = { epoch: string; seq: bigint };

export type RangeRow = RangeKey & { payload: Uint8Array | null };

export type SealedRecord = { record: ui.ThreadSyncRecord; size: number };

/** Do not read/decode the unused suffix of a sealed batch. Reserve its envelope. */
export function rangeRows(
  sql: SqlClient.SqlClient,
  owner: string,
  thread: string,
  epoch: string,
  applied: bigint,
  end: bigint,
) {
  return sql<RangeRow>`WITH candidates AS MATERIALIZED (
    SELECT j.seq,j.kind,j.entity_id,j.payload FROM thread_replication_journal j
      JOIN threads t ON t.id=j.thread_id JOIN thread_replication_clock c ON c.thread_id=t.id
    WHERE j.thread_id=${thread}::uuid AND j.epoch=${epoch}::uuid AND c.epoch=j.epoch AND c.head_seq>=${end}
      AND t.owner_user_id=${owner}::uuid AND t.deleted_at IS NULL
      AND j.seq>${applied} AND j.seq<=${end} ORDER BY j.seq LIMIT 64
  ), sized AS (
    SELECT *,sum(coalesce(octet_length(payload),0)+6) OVER (ORDER BY seq) AS bytes FROM candidates
  ) SELECT seq::text,kind,entity_id,payload FROM sized
    WHERE bytes<=${THREAD_BATCH_BYTES - 256} ORDER BY sized.seq`;
}

export function rangeBatch(
  cursor: ui.ThreadSyncCursor,
  head: bigint,
  end: bigint,
  rows: readonly RangeRow[],
  subscription: string,
  sealed: ReadonlyMap<bigint, SealedRecord> = new Map(),
) {
  if (
    (cursor.appliedSeq < end && !rows.length) ||
    rows.some((row, index) => BigInt(row.seq) !== cursor.appliedSeq + BigInt(index) + 1n)
  )
    throw new ConnectError("Thread journal range is missing", Code.DataLoss);

  const records = rows.map((row) => (row.payload ? decodeRecord(row.payload) : sealed.get(BigInt(row.seq))!.record));

  return packThreadBatch(
    cursor,
    head,
    records,
    subscription,
    rows.map((row) => row.payload?.length ?? sealed.get(BigInt(row.seq))!.size),
  );
}

function decodeRecord(data: Uint8Array) {
  try {
    return fromBinary(ui.ThreadSyncRecordSchema, data);
  } catch {
    throw new ConnectError("Thread journal record could not be decoded", Code.DataLoss, {
      "canopy-sync-reason": "decode_error",
      "canopy-frame-bytes": String(data.length),
    });
  }
}
