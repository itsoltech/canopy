import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readMessage(request, ui.SearchIssuesRequestSchema);
    const result = await call((api) => api.searchIssues(body, { signal: request.signal, timeoutMs: 35_000 }));

    return json(encode(ui.SearchIssuesResponseSchema, result));
  } catch (cause) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    throw cause;
  }
};
