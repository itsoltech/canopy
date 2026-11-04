import type { JsonObject, JsonValue } from "@canopy/domain";

/** Narrows JSON that is already parsed (tool arguments, jsonb); it decodes nothing. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}
