import { isHttpError, json } from "@sveltejs/kit";
import { threadCreationSnapshot } from "#lib/features/threads/server/thread-creation-jobs.ts";
import { failWith } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  try {
    return json(threadCreationSnapshot(params.requestId), { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    if (isHttpError(cause)) throw cause;
    failWith(cause);
  }
};
