import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Fuzzy file search in the thread's folder on its worker. A read: POST only because the request is a protobuf message. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SearchFilesRequestSchema);
  return json(encode(ui.SearchFilesResponseSchema, await call((api) => api.searchFiles(body))));
};
