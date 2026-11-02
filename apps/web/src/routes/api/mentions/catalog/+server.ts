import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Commands, skills and plugins for the composer's popup (the thread's or a new thread's worker). A read: POST only because the request is a protobuf message. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ListMentionCatalogRequestSchema);
  return json(encode(ui.ListMentionCatalogResponseSchema, await call((api) => api.listMentionCatalog(body, { timeoutMs: 50_000 }))));
};
