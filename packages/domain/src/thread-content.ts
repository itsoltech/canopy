import { fromBinary, fromJsonString } from "@bufbuild/protobuf";
import { ItemSchema, ui } from "@canopy/contracts";
import { qualifyThreadItem } from "./thread-content-ids.ts";

/** Explicit item expansion only. Transport reads remain bounded and sequential. */
export async function loadThreadItem(
  reference: ui.ThreadSyncContent,
  read: (offset: bigint, length: number) => Promise<ui.ThreadSyncContentChunk>,
  signal: AbortSignal,
  threadId = "",
) {
  if (reference.sizeBytes <= 0n || reference.sizeBytes > 64n * 1024n * 1024n)
    throw new Error("This item is too large to display in full.");
  const data = new Uint8Array(Number(reference.sizeBytes));
  let offset = 0n;

  while (offset < reference.sizeBytes) {
    signal.throwIfAborted();
    const chunk = await read(offset, 48 * 1024);
    signal.throwIfAborted();

    if (
      chunk.offset !== offset ||
      chunk.sizeBytes !== reference.sizeBytes ||
      !chunk.data.length ||
      chunk.data.length > 48 * 1024 ||
      offset + BigInt(chunk.data.length) > reference.sizeBytes
    )
      throw new Error("Item content range is incomplete.");
    data.set(chunk.data, Number(offset));
    offset += BigInt(chunk.data.length);
  }

  if (reference.encoding === "json" && reference.typeName === ItemSchema.typeName)
    return qualifyThreadItem(
      fromJsonString(ItemSchema, new TextDecoder().decode(data), { ignoreUnknownFields: true }),
      threadId,
    );

  if (reference.typeName === ui.TimelineItemSchema.typeName) {
    const item = fromBinary(ui.TimelineItemSchema, data).item;

    if (item) return qualifyThreadItem(item, threadId);
  } else if (reference.typeName === ui.ThreadSyncRecordSchema.typeName) {
    const value = fromBinary(ui.ThreadSyncRecordSchema, data).value;

    if (value.case === "item" && value.value.item) return qualifyThreadItem(value.value.item, threadId);
  }

  throw new Error("Item content is unavailable in this version of Canopy.");
}
