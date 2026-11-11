import { ScalarType, type DescMessage, type Message } from "@bufbuild/protobuf";
import { isReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { ItemSchema, MentionKind, type Item } from "@canopy/contracts";
import { qualifyId, splitId } from "./computers.ts";

/** Lazy bytes stay content-addressed. Qualify decoded references exactly once at the client boundary. */
export function qualifyThreadItem(item: Item, threadId: string) {
  const node = splitId(threadId).node;

  if (node) qualifyMessage(ItemSchema, item, node);

  return item;
}

function qualifyMessage(desc: DescMessage, message: Message, node: string) {
  const record = reflect(desc, message);

  const idField = (name: string) =>
    name !== "global_id" && (name === "id" || name.endsWith("_id") || name.endsWith("_ids"));

  if (
    desc.typeName === "canopy.worker.v1.Mention" &&
    [MentionKind.BOT, MentionKind.THREAD, MentionKind.CONNECTOR, MentionKind.ATTACHMENT].some(
      (kind) => kind === record.get(desc.field["kind"]!),
    )
  ) {
    const field = desc.field["name"]!;
    record.set(field, qualifyId(String(record.get(field)), node));
  }

  for (const field of desc.fields) {
    if (!record.isSet(field)) continue;

    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING && idField(field.name))
      record.set(field, qualifyId(record.get(field), node));
    else if (field.fieldKind === "message") qualifyMessage(field.message, record.get(field).message, node);
    else if (field.fieldKind === "list" && field.listKind === "message") {
      for (const value of record.get(field))
        if (isReflectMessage(value)) qualifyMessage(field.message, value.message, node);
    } else if (
      field.fieldKind === "list" &&
      field.listKind === "scalar" &&
      field.scalar === ScalarType.STRING &&
      idField(field.name)
    ) {
      const values = record.get(field);

      for (const [index, value] of values.entries()) {
        // SAFETY: The descriptor guarantees scalar STRING values in this reflected list.
        values.set(index, qualifyId(value as string, node));
      }
    }
  }
}
