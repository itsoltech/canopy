import { fromJson, toJson, type DescMessage, type JsonValue, type MessageShape } from "@bufbuild/protobuf";

/**
 * Protobuf messages cross the BFF <-> browser boundary as protobuf JSON and are decoded with the
 * same generated schemas on both sides, so the browser works with the typed contract too.
 */
export const encode = <D extends DescMessage>(schema: D, message: MessageShape<D>): JsonValue => toJson(schema, message);
export const decode = <D extends DescMessage>(schema: D, json: unknown): MessageShape<D> => fromJson(schema, json as JsonValue);
