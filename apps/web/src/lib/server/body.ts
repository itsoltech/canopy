import { error } from "@sveltejs/kit";
import { fromJson, type DescMessage, type JsonValue, type MessageShape } from "@bufbuild/protobuf";
import { Result, Schema } from "effect";

/** Parses a JSON body; anything else is a 415 or 400. */
async function readJson(request: Request): Promise<unknown> {
  // A cross-site HTML form cannot send this content type, so it is also a CSRF guard.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    error(415, "content-type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    error(400, "body must be JSON");
  }
}

/** Strict JSON body decoding for BFF endpoints: unknown fields and wrong types are 400s. */
export async function readBody<S extends Schema.Codec<unknown>>(request: Request, schema: S): Promise<Schema.Schema.Type<S>> {
  const decoded = Schema.decodeUnknownResult(schema)(await readJson(request), { onExcessProperty: "error" });
  if (Result.isFailure(decoded)) error(400, decoded.failure.message);
  return decoded.success as Schema.Schema.Type<S>;
}

/** A body that is a contract message in protobuf JSON (strict: unknown fields are 400s). */
export async function readMessage<D extends DescMessage>(request: Request, schema: D): Promise<MessageShape<D>> {
  const raw = await readJson(request);
  try {
    return fromJson(schema, raw as JsonValue);
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "invalid body");
  }
}
