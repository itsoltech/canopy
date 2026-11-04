/** JSON data at I/O boundaries; decode it before treating it as a domain value. */
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

/** A JSON object, not an array or null. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !isJsonArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}
