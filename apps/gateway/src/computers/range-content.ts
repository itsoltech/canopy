import { clone, create, ScalarType, toBinary } from "@bufbuild/protobuf";
import { isReflectMessage, reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { ui } from "@canopy/contracts";
import { createHash } from "node:crypto";

/** Only oversized records pay for reflection/copying; ordinary deltas keep their fast path. */
export function compactRangeRecord(record: ui.ThreadSyncRecord) {
  const data = toBinary(ui.ThreadSyncRecordSchema, record);

  if (data.length <= 24 * 1024) return { record, data };
  const sha256 = createHash("sha256").update(data).digest("hex");
  const preview = clone(ui.ThreadSyncRecordSchema, record);
  compact(reflect(ui.ThreadSyncRecordSchema, preview));
  preview.content = create(ui.ThreadSyncContentSchema, {
    sha256,
    sizeBytes: BigInt(data.length),
    typeName: ui.ThreadSyncRecordSchema.typeName,
  });

  if (preview.value.case === "item") preview.value.value.contentRef = preview.content;

  let encoded = toBinary(ui.ThreadSyncRecordSchema, preview);

  if (encoded.length > 24 * 1024) {
    preview.value = { case: undefined };
    encoded = toBinary(ui.ThreadSyncRecordSchema, preview);
  }

  return { record: preview, data: encoded, content: { sha256, data } };
}

function compact(message: ReflectMessage) {
  for (const field of message.fields) {
    if (!message.isSet(field)) continue;

    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING) {
      const value = message.get(field);

      if (value.length > 2048)
        message.set(
          field,
          field.name.endsWith("_json")
            ? JSON.stringify({ preview: value.slice(0, 512), truncated: true })
            : value.slice(0, 2048),
        );
    } else if (field.fieldKind === "scalar" && field.scalar === ScalarType.BYTES) {
      if (message.get(field).length > 2048) message.clear(field);
    } else if (field.fieldKind === "message") compact(message.get(field));
    else if (field.fieldKind === "list") {
      const list = message.get(field);

      if (list.size > 16) list.clear();
      else for (const item of list) if (isReflectMessage(item)) compact(item);
    } else if (field.fieldKind === "map") message.clear(field);
  }
}
