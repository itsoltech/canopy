import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { MentionSchema, type Mention } from "@canopy/contracts";

/** Mentions across the BFF (JSON body of a message, a hidden form field of a new thread): protobuf JSON. */
export const mentionsToWire = (mentions: readonly Mention[]): JsonValue[] => mentions.map((m) => toJson(MentionSchema, m));

/** Throws on anything that is not a mention (the route answers 400). At most 50, like the gateway. */
export function mentionsFromWire(value: unknown): Mention[] {
  if (value === undefined || value === null || value === "") return [];
  const list = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(list) || list.length > 50) throw new Error("mentions: up to 50 mentions");
  return list.map((m) => fromJson(MentionSchema, m as JsonValue));
}
