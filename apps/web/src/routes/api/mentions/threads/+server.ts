import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** The user's threads by title, to mention one. A read: POST only because the request is a protobuf message. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SearchThreadsRequestSchema);
  return json(encode(ui.SearchThreadsResponseSchema, await call((api) => api.searchThreads(body))));
};
