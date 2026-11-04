import { fromJson, toJson, type DescMessage, type JsonValue as ProtoJson, type MessageShape } from "@bufbuild/protobuf";
import type { JsonValue } from "./json.ts";

/**
 * Protobuf messages cross the BFF <-> browser boundary as protobuf JSON and are decoded with the
 * same generated schemas on both sides, so the browser works with the typed contract too.
 */
export const encode = <D extends DescMessage>(schema: D, message: MessageShape<D>): ProtoJson =>
  toJson(schema, message);

export const decode = <D extends DescMessage>(schema: D, json: JsonValue): MessageShape<D> =>
  // SAFETY: both types describe the same JSON values; protobuf's only lists arrays as mutable, and fromJson
  // reads its input without changing it.
  fromJson(schema, json as ProtoJson);
