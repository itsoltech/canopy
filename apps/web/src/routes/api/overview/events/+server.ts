import { ui } from "@canopy/contracts";
import { call, gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Live overview (workers, projects, thread statuses) as SSE. */
export const GET: RequestHandler = async ({ request }) => {
  await call((api) => api.getOverview({}, { signal: request.signal }));
  return sseResponse(request, (signal) => gateway().watchOverview({}, { signal, timeoutMs: 0 }), (update) => encode(ui.OverviewUpdateSchema, update));
};
