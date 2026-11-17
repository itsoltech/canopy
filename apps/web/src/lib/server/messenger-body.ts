import { fromJson, type DescMessage, type MessageShape, type JsonValue } from "@bufbuild/protobuf";
import { error } from "@sveltejs/kit";
import { bodyJson } from "#lib/shared/json.ts";

/** Reject unknown credential fields without reflecting credentials in parse errors. */
export async function readMessengerMessage<D extends DescMessage>(
  request: Request,
  schema: D,
): Promise<MessageShape<D>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    error(415, "Send messenger settings as JSON and try again.");

  try {
    // SAFETY: bodyJson and protobuf describe the same JSON values; fromJson only reads arrays.
    return fromJson(schema, (await bodyJson(request)) as JsonValue);
  } catch {
    error(400, "Could not read messenger settings. Check the fields and try again.");
  }
}
