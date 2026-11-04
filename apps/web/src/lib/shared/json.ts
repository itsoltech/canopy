import type { JsonObject, JsonValue } from "@canopy/domain";

export type { JsonObject, JsonValue };

/**
 * JSON that tools, harnesses and the gateway hand the UI as text (tool inputs and results, interaction
 * requests): parsed once into JSON values, then read field by field. A field of another shape reads as
 * empty, so a view shows what it understands and leaves the rest out.
 */

/** Parses JSON text; undefined when it is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse only produces JSON values: strings, numbers, booleans, null, arrays and plain objects.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** A request's or response's JSON body; rejects when it is not JSON, like `Body.json()`. */
export async function bodyJson(body: Body): Promise<JsonValue> {
  // SAFETY: Body.json() parses the body with JSON.parse, which only produces JSON values.
  return (await body.json()) as JsonValue;
}

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isJsonArray = (value: JsonValue | undefined): value is readonly JsonValue[] => Array.isArray(value);

export const isString = <T>(value: T): value is T & string => typeof value === "string";

export const isNumber = <T>(value: T): value is T & number => typeof value === "number";

/** Parses a JSON object; anything else (invalid, array, scalar) gives an empty object. */
export const parseObject = (json: string): JsonObject => objectOf(parseJson(json));

/** A value as an object; anything else gives an empty object. */
export const objectOf = (value: JsonValue | undefined): JsonObject => (isJsonObject(value) ? value : {});

/** A value as a list; anything else gives an empty list. */
export const listOf = (value: JsonValue | undefined): readonly JsonValue[] => (isJsonArray(value) ? value : []);

/** The objects of a list value, others left out. */
export const objectsOf = (value: JsonValue | undefined): JsonObject[] => listOf(value).filter(isJsonObject);

export const str = (value: JsonValue | undefined): string => (isString(value) ? value : "");

export const num = (value: JsonValue | undefined): number => (isNumber(value) ? value : 0);
