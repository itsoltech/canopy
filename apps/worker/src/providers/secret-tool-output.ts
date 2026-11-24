import type { JsonValue } from "@canopy/domain";
import { isJsonObject, isString } from "./json.ts";

/** Redact JSON keys and values, keeping the input itself when nothing changed. */
export function redactToolOutput(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (isString(value)) return redact(value);

  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactToolOutput(item, redact));

    return redacted.some((item, index) => item !== value[index]) ? redacted : value;
  }

  if (isJsonObject(value)) {
    let changed = false;
    const entriesByKey = new Map<string, [JsonValue, ...JsonValue[]]>();

    for (const [key, item] of Object.entries(value)) {
      const nextKey = redact(key);
      const next = redactToolOutput(item, redact);
      changed ||= key !== nextKey || item !== next;
      const entries = entriesByKey.get(nextKey);

      if (entries) entries.push(next);
      else entriesByKey.set(nextKey, [next]);
    }

    if (!changed) return value;

    // Keep every value under the masked key when several original keys map to it.
    return Object.fromEntries(
      Array.from(entriesByKey, ([key, entries]) => [key, entries.length === 1 ? entries[0] : entries]),
    );
  }

  return value;
}
