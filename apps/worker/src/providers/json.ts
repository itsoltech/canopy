import { Schema } from "effect";
import type { JsonValue } from "@canopy/domain";

/** Decode external JSON before inspecting provider-specific fields. */
export const decodeJson = Schema.decodeUnknownSync(Schema.MutableJson);
export const decodeJsonObject = Schema.decodeUnknownSync(Schema.JsonObject);
export const isJsonObject = Schema.is(Schema.JsonObject);
export const isString = Schema.is(Schema.String);
export const isNumber = Schema.is(Schema.Number);
export const isBoolean = Schema.is(Schema.Boolean);

/** Optional JSON fields retain their absence; non-objects have no named fields. */
export function jsonObject(value: JsonValue | undefined) {
  return isJsonObject(value) ? value : undefined;
}

export function jsonString(value: JsonValue | undefined): string {
  return isString(value) ? value : "";
}
