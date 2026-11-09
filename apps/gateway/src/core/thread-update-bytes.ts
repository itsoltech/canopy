import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

const textBytes = new WeakMap<ui.ThreadUpdate, Uint8Array>();

/**
 * Published text events and coalesced text batches are immutable. Configuration translation
 * has no fields to rewrite in ItemDelta. Share their encoding for queue accounting and linked
 * subscribers; never cache snapshots or other messages that configuration mapping can mutate.
 * The weak key retains no event history after the subscribers release the update.
 */
export function threadUpdateBytes(update: ui.ThreadUpdate): Uint8Array {
  if (update.change.case !== "event" || update.change.value.event?.body.case !== "itemDelta")
    return toBinary(ui.ThreadUpdateSchema, update);
  let bytes = textBytes.get(update);

  if (!bytes) {
    bytes = toBinary(ui.ThreadUpdateSchema, update);
    textBytes.set(update, bytes);
  }

  return bytes;
}
