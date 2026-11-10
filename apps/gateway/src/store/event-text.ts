import { type JsonValue } from "@bufbuild/protobuf";
import {
  isReflectList,
  isReflectMap,
  isReflectMessage,
  reflect,
  type ReflectMessage,
} from "@bufbuild/protobuf/reflect";
import { ThreadEventSchema, type ThreadEvent } from "@canopy/contracts";
import { Predicate } from "effect";

/** PostgreSQL text/jsonb reject NUL and unpaired UTF-16 surrogates. Keep valid pairs intact. */
export function storageText(value: string): string {
  const wellFormed = value.isWellFormed() ? value : value.toWellFormed();

  return wellFormed.includes("\u0000") ? wellFormed.replaceAll("\u0000", "\ufffd") : wellFormed;
}

/** Collect edits without cloning ordinary events or touching bytes/numbers. */
function edits(message: ReflectMessage, apply: boolean): boolean {
  let changed = false;

  for (const field of message.fields) {
    if (!message.isSet(field)) continue;
    const value = message.get(field);

    if (Predicate.isString(value)) {
      const next = storageText(value);

      if (next !== value) {
        changed = true;

        if (apply) message.set(field, next);
      }
    } else if (isReflectMessage(value)) {
      changed = edits(value, apply) || changed;
    } else if (isReflectList(value)) {
      for (const [index, entry] of value.entries()) {
        if (isReflectMessage(entry)) changed = edits(entry, apply) || changed;
        else if (Predicate.isString(entry) && storageText(entry) !== entry) {
          changed = true;

          if (apply) value.set(index, storageText(entry));
        }
      }
    } else if (isReflectMap(value)) {
      for (const [key, entry] of value) {
        const nextKey = Predicate.isString(key) ? storageText(key) : key;

        if (nextKey !== key) {
          changed = true;

          if (apply) {
            value.delete(key);
            value.set(nextKey, entry);
          }
        }

        if (isReflectMessage(entry)) changed = edits(entry, apply) || changed;
        else if (Predicate.isString(entry) && storageText(entry) !== entry) {
          changed = true;

          if (apply) value.set(nextKey, storageText(entry));
        }
      }
    }
  }

  return changed;
}

/** Decode escaped JSON strings before SQL's jsonb cast; literal backslash-u text stays literal. */
function rawJson(value: string): string {
  if (!/\\u(?:0000|d[89a-f][0-9a-f]{2})/i.test(value) && !value.includes("\u0000")) return value;

  // Parse only suspicious raw JSON. Invalid JSON remains a class-22 storage error for quarantine.
  try {
    return JSON.stringify(storageJson(JSON.parse(value)));
  } catch {
    return value;
  }
}

export function storageJson(value: JsonValue): JsonValue {
  if (Predicate.isString(value)) return storageText(value);

  if (Array.isArray(value)) return value.map(storageJson);

  if (Predicate.isObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [storageText(key), storageJson(entry)]));

  return value;
}

/** Single event persistence normalizer, shared by thread and bot ingestion, including journal replay. */
export function storageEvent(event: ThreadEvent): ThreadEvent {
  const raw = rawJson(event.rawJson);

  if (raw === event.rawJson && !edits(reflect(ThreadEventSchema, event), false)) return event;
  // Protobuf clone validates UTF-16 before we can repair lone surrogates.
  const next = structuredClone(event);
  next.rawJson = raw;
  edits(reflect(ThreadEventSchema, next), true);

  return next;
}
