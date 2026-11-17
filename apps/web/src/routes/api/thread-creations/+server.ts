import { error, isHttpError, json } from "@sveltejs/kit";
import { Result, Schema } from "effect";
import { parseThreadForm } from "#lib/features/threads/server/create-thread.ts";
import { startThreadCreation } from "#lib/features/threads/server/thread-creation-jobs.ts";
import { failed, failWith } from "#lib/server/gateway.ts";
import { requireSameOrigin } from "#lib/server/files.ts";
import type { RequestHandler } from "./$types";

const RequestId = Schema.String.check(Schema.isUUID());

export const POST: RequestHandler = async ({ request, url }) => {
  requireSameOrigin(request, url);
  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    error(400, "Could not read this message. Reload the page, then retry.");
  }

  const requestId = Schema.decodeUnknownResult(RequestId)(form.get("clientRequestId"));

  if (Result.isFailure(requestId)) error(400, "A valid message request ID is required");
  form.set("clientRequestId", requestId.success.toLowerCase());
  const parsed = parseThreadForm(form, "thread", { projectId: String(form.get("projectId") ?? "") });

  if (failed(parsed)) error(parsed.status, parsed.data.error);
  let id: string;

  try {
    id = startThreadCreation(parsed);
  } catch (cause) {
    // Local capacity/idempotency errors already have public HTTP messages.
    if (isHttpError(cause)) throw cause;
    failWith(cause);
  }

  return json({ requestId: id }, { status: 202, headers: { "cache-control": "no-store" } });
};
