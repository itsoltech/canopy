import { error } from "@sveltejs/kit";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { Result, Schema } from "effect";
import { isEntityId } from "@canopy/domain/computers";
import { bodyJson, type JsonValue } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";

/** A uuid of this computer or of a linked one (qualified, docs/linked-computers.md). */
export const EntityId = Schema.String.check(
  Schema.makeFilter((value: string) => isEntityId(value) || "Expected an id"),
);

/** Parses a JSON body; anything else is a 415 or 400. */
async function readJson(request: Request): Promise<JsonValue> {
  // A cross-site HTML form cannot send this content type, so it is also a CSRF guard.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    error(415, "content-type must be application/json");
  }

  try {
    return await bodyJson(request);
  } catch {
    error(400, "body must be JSON");
  }
}

/** Strict JSON body decoding for BFF endpoints: unknown fields and wrong types are 400s. */
export async function readBody<S extends Schema.Codec<unknown>>(request: Request, schema: S): Promise<S["Type"]> {
  const decoded = Schema.decodeUnknownResult(schema)(await readJson(request), { onExcessProperty: "error" });

  if (Result.isFailure(decoded)) error(400, decoded.failure.message);

  return decoded.success;
}

/** A body that is a contract message in protobuf JSON (strict: unknown fields are 400s). */
export async function readMessage<D extends DescMessage>(request: Request, schema: D): Promise<MessageShape<D>> {
  const raw = await readJson(request);

  try {
    return decode(schema, raw);
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "invalid body");
  }
}
