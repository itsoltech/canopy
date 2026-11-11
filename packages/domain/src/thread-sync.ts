import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export const THREAD_BATCH_RECORDS = 64;
export const THREAD_BATCH_BYTES = 64 * 1024;

export class ThreadSyncGap extends Error {
  constructor(
    readonly appliedSeq: bigint,
    readonly expectedSeq?: bigint,
    readonly receivedSeq?: bigint,
  ) {
    super(
      `Thread sequence range is incomplete${expectedSeq === undefined ? "" : ` (expected ${expectedSeq}, received ${receivedSeq})`}`,
    );
  }
}

/** Validate before writing anything. Unknown additive record cases still occupy a sequence. */
export function validateThreadBatch(batch: ui.ThreadSyncBatch, applied: bigint) {
  if (
    batch.records.length > THREAD_BATCH_RECORDS ||
    toBinary(ui.ThreadSyncBatchSchema, batch).length > THREAD_BATCH_BYTES
  )
    throw new Error("Thread batch exceeds its negotiated limit");

  if (
    batch.baseSeq !== applied ||
    batch.headSeq < batch.appliedSeq ||
    batch.remaining !== batch.headSeq - batch.appliedSeq
  )
    throw new ThreadSyncGap(applied);
  let seq = applied;

  for (const record of batch.records) {
    seq++;

    if (record.seq !== seq) throw new ThreadSyncGap(applied, seq, record.seq);

    if (!record.key) throw new Error("Thread record has no entity key");
  }

  if (seq !== batch.appliedSeq || batch.caughtUp !== (seq === batch.headSeq)) throw new ThreadSyncGap(applied);
}

/** Count the actual encoded envelope, including repeated-field tags and lengths. */
export function packThreadBatch(
  cursor: ui.ThreadSyncCursor,
  head: bigint,
  records: readonly ui.ThreadSyncRecord[],
  subscriptionId = "",
  encodedSizes?: readonly number[],
) {
  const batch = create(ui.ThreadSyncBatchSchema, {
    threadId: cursor.threadId,
    epoch: cursor.epoch,
    baseSeq: cursor.appliedSeq,
    appliedSeq: cursor.appliedSeq,
    headSeq: head,
    remaining: head - cursor.appliedSeq,
    subscriptionId,
  });

  let bytes = toBinary(ui.ThreadSyncBatchSchema, batch).length + 64;

  for (let index = 0; index < Math.min(records.length, THREAD_BATCH_RECORDS); index++) {
    const record = records[index]!;
    const size = (encodedSizes?.[index] ?? toBinary(ui.ThreadSyncRecordSchema, record).length) + 6;

    if (bytes + size > THREAD_BATCH_BYTES) break;
    batch.records.push(record);
    batch.appliedSeq = record.seq;
    bytes += size;
  }

  batch.remaining = head - batch.appliedSeq;
  batch.caughtUp = batch.remaining === 0n;

  if (records.length && !batch.records.length) throw new Error("Thread record requires lazy content");

  return batch;
}
