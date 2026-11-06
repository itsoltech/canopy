import type { JsonValue } from "@canopy/domain";

export {
  isJsonArray,
  isJsonObject,
  isNumber,
  isString,
  listOf,
  num,
  objectOf,
  objectsOf,
  parseJson,
  parseObject,
  str,
} from "@canopy/domain/json";

export type { JsonObject, JsonValue } from "@canopy/domain";

/** A request's or response's JSON body; rejects when it is not JSON, like `Body.json()`. */
export async function bodyJson(body: Body): Promise<JsonValue> {
  // SAFETY: Body.json() parses the body with JSON.parse, which only produces JSON values.
  return (await body.json()) as JsonValue;
}
