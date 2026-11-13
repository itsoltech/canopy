import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { RangeSourceStore } from "../computers/range-source.ts";
import type { sequenceRanges } from "./sequence-ranges.ts";

/** A finite sequence read. A distant cache gets a bounded tail, never a historical replay. */
export async function* warmSequenceThread(
  store: RangeSourceStore,
  ranges: ReturnType<typeof sequenceRanges>,
  input: ui.WatchThreadRequest,
  signal: AbortSignal,
) {
  let cursor = input.syncCursor;

  if (cursor && cursor.threadId !== input.threadId)
    throw new ConnectError("Thread cursor identity mismatch", Code.InvalidArgument);

  const clock = (
    await store.query<{ epoch: string; head: string }>(
      `SELECT c.epoch,c.head_seq::text AS head FROM thread_replication_clock c JOIN threads t ON t.id=c.thread_id
      WHERE c.thread_id=$1::uuid AND t.owner_user_id=$2::uuid AND t.deleted_at IS NULL`,
      [input.threadId, store.owner],
    )
  )[0];

  const head = BigInt(clock?.head ?? 0);

  if (
    !cursor ||
    !clock ||
    cursor.epoch !== clock.epoch ||
    cursor.appliedSeq > head ||
    head - cursor.appliedSeq > 256n
  ) {
    if (signal.aborted) return;

    const snapshot = await ranges.window(
      create(ui.WatchThreadRequestSchema, { threadId: input.threadId, sequence: true, pageSize: 24 }),
    );

    if (!signal.aborted) yield create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } });

    return;
  }

  // A growing thread cannot prolong this job. The next head signal schedules its next bounded read.
  for (let count = 0; count < 4 && !signal.aborted; count++) {
    const batch = await ranges.read(cursor, head);

    if (batch.epoch !== cursor.epoch) return;
    yield create(ui.ThreadUpdateSchema, { change: { case: "batch", value: batch } });
    cursor = create(ui.ThreadSyncCursorSchema, {
      threadId: batch.threadId,
      epoch: batch.epoch,
      appliedSeq: batch.appliedSeq,
    });

    if (cursor.appliedSeq >= head) return;
  }
}
