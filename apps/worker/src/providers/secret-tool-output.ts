import type { JsonValue } from "@canopy/domain";
import { isJsonObject, isString } from "./json.ts";

/** Keep the native output shape and return the input itself when its contents did not change. */
export function redactToolOutput(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (isString(value)) return redact(value);

  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactToolOutput(item, redact));

    return redacted.some((item, index) => item !== value[index]) ? redacted : value;
  }

  if (isJsonObject(value)) {
    let changed = false;

    const redacted = Object.entries(value).map(([key, item]) => {
      const next = redactToolOutput(item, redact);
      changed ||= item !== next;

      return [key, next] as const;
    });

    return changed ? Object.fromEntries(redacted) : value;
  }

  return value;
}
