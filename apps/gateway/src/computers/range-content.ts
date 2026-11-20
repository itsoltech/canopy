import { clone, create, ScalarType, toBinary } from "@bufbuild/protobuf";
import { isReflectMessage, reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { ui } from "@canopy/contracts";
import { createHash } from "node:crypto";

const MAX_RECORD_BYTES = 24 * 1024;

/** Only oversized records pay for reflection/copying; ordinary deltas keep their fast path. */
export function compactRangeRecord(record: ui.ThreadSyncRecord) {
  const data = toBinary(ui.ThreadSyncRecordSchema, record);

  if (data.length <= MAX_RECORD_BYTES) return { record, data };

  // SQL may have persisted the complete Item already. A large preview can
  // still exceed the frame budget, for example when it contains many diffs.
  const existing = record.value.case === "item" ? record.value.value.contentRef : undefined;
  const content = existing ? undefined : { sha256: createHash("sha256").update(data).digest("hex"), data };
  const preview = clone(ui.ThreadSyncRecordSchema, record);
  compact(reflect(ui.ThreadSyncRecordSchema, preview));
  preview.content = content
    ? create(ui.ThreadSyncContentSchema, {
        sha256: content.sha256,
        sizeBytes: BigInt(data.length),
        typeName: ui.ThreadSyncRecordSchema.typeName,
      })
    : existing;

  if (preview.value.case === "item") preview.value.value.contentRef = preview.content;

  let encoded = toBinary(ui.ThreadSyncRecordSchema, preview);

  if (encoded.length > MAX_RECORD_BYTES && existing) {
    compact(reflect(ui.ThreadSyncRecordSchema, preview), 512);
    encoded = toBinary(ui.ThreadSyncRecordSchema, preview);
  }

  if (encoded.length > MAX_RECORD_BYTES) {
    preview.value = { case: undefined };
    encoded = toBinary(ui.ThreadSyncRecordSchema, preview);
  }

  return { record: preview, data: encoded, content };
}

function compact(message: ReflectMessage, textLimit = 2048) {
  for (const field of message.fields) {
    if (!message.isSet(field)) continue;

    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING) {
      const value = message.get(field);

      if (value.length > textLimit)
        message.set(
          field,
          field.name.endsWith("_json")
            ? JSON.stringify({ preview: value.slice(0, Math.min(512, textLimit)), truncated: true })
            : value.slice(0, textLimit),
        );
    } else if (field.fieldKind === "scalar" && field.scalar === ScalarType.BYTES) {
      if (message.get(field).length > textLimit) message.clear(field);
    } else if (field.fieldKind === "message") compact(message.get(field), textLimit);
    else if (field.fieldKind === "list") {
      const list = message.get(field);

      if (list.size > 16) list.clear();
      else for (const item of list) if (isReflectMessage(item)) compact(item, textLimit);
    } else if (field.fieldKind === "map") message.clear(field);
  }
}
