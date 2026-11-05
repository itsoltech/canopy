import { toJson, type JsonValue as ProtoJson } from "@bufbuild/protobuf";
import { MentionSchema, type Mention } from "@canopy/contracts";
import { isJsonArray, isString, parseJson, type JsonValue } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";

/** Mentions across the BFF (JSON body of a message, a hidden form field of a new thread): protobuf JSON. */
export const mentionsToWire = (mentions: readonly Mention[]): ProtoJson[] =>
  mentions.map((m) => toJson(MentionSchema, m));

/** Throws on anything that is not a mention (the route answers 400). At most 150, like the gateway (50 + 100 files). */
export function mentionsFromWire(value: FormDataEntryValue | readonly JsonValue[] | null | undefined): Mention[] {
  if (value === undefined || value === null || value === "") return [];
  const list = value instanceof File ? undefined : isString(value) ? parseJson(value) : value;

  if (!isJsonArray(list) || list.length > 150) throw new Error("mentions: up to 150 mentions");

  return list.map((m) => decode(MentionSchema, m));
}
