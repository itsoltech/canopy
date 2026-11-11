import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { packThreadBatch } from "@canopy/domain/thread-sync";

/** Qualifying references can grow a frame; preserve the wire bound after mapping. */
export function* boundRoutedThread(update: ui.ThreadUpdate) {
  if (update.change.case !== "batch") {
    yield update;

    return;
  }

  const original = update.change.value;

  let cursor = create(ui.ThreadSyncCursorSchema, {
    threadId: original.threadId,
    epoch: original.epoch,
    appliedSeq: original.baseSeq,
  });

  let offset = 0;

  do {
    const batch = packThreadBatch(cursor, original.headSeq, original.records.slice(offset), original.subscriptionId);
    yield create(ui.ThreadUpdateSchema, { ...update, change: { case: "batch", value: batch } });
    offset += batch.records.length;
    cursor = create(ui.ThreadSyncCursorSchema, {
      threadId: batch.threadId,
      epoch: batch.epoch,
      appliedSeq: batch.appliedSeq,
    });
  } while (offset < original.records.length);
}
