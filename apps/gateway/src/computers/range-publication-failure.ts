import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import type { RangeSourceStore } from "./range-source.ts";
import type { RangeThreadHead } from "./range-overview.ts";

export type PublicationFailureRow = {
  failure_signature: string | null;
  failure_payload: Uint8Array | null;
  failure_attempts: number | null;
  failure_next: string | null;
  failure_at: string | null;
};

export function publicationFailure(thread: RangeThreadHead, signature: string) {
  if (!thread.failure_payload || thread.failure_signature !== signature) return undefined;

  return {
    attempts: thread.failure_attempts ?? 1,
    next: thread.failure_next === null ? Infinity : Number(thread.failure_next),
    at: Number(thread.failure_at),
    failure: fromBinary(link.ThreadRangeFailureSchema, thread.failure_payload),
  };
}

/** Keep suppression across reconnects without keeping one heap entry per failed thread. */
export async function savePublicationFailure(
  store: RangeSourceStore,
  thread: string,
  signature: string,
  failure: link.ThreadRangeFailure,
  attempts: number,
) {
  const now = Date.now();
  const next = failure.retryable ? now + Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)) : null;
  const payload = toBinary(link.ThreadRangeFailureSchema, failure);
  await store.query(
    `INSERT INTO thread_publication_failures(thread_id,signature,payload,attempts,retry_at,failed_at)
    SELECT $1::uuid,$3,$4,$5,$6,$7 FROM threads t
      WHERE t.id=$1::uuid AND t.owner_user_id=$2::uuid AND t.deleted_at IS NULL
    ON CONFLICT(thread_id) DO UPDATE SET signature=excluded.signature,payload=excluded.payload,
      attempts=excluded.attempts,retry_at=excluded.retry_at,failed_at=excluded.failed_at`,
    [thread, store.owner, signature, payload, attempts, next, now],
  );

  return {
    failure_signature: signature,
    failure_payload: payload,
    failure_attempts: attempts,
    failure_next: next?.toString() ?? null,
    failure_at: now.toString(),
  };
}

export async function clearPublicationFailure(store: RangeSourceStore, thread: string) {
  await store.query(
    `DELETE FROM thread_publication_failures f USING threads t
    WHERE f.thread_id=t.id AND t.id=$1::uuid AND t.owner_user_id=$2::uuid`,
    [thread, store.owner],
  );
}
