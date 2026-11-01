import { error } from "@sveltejs/kit";
import { Result, Schema } from "effect";

/** Strict JSON body decoding for BFF endpoints: unknown fields and wrong types are 400s. */
export async function readBody<S extends Schema.Codec<unknown>>(request: Request, schema: S): Promise<Schema.Schema.Type<S>> {
  // A cross-site HTML form cannot send this content type, so it is also a CSRF guard.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    error(415, "content-type must be application/json");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    error(400, "body must be JSON");
  }
  const decoded = Schema.decodeUnknownResult(schema)(raw, { onExcessProperty: "error" });
  if (Result.isFailure(decoded)) error(400, decoded.failure.message);
  return decoded.success as Schema.Schema.Type<S>;
}
