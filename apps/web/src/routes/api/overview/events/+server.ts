import { ui } from "@open-agents/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Live overview (workers, projects, thread statuses) as SSE. */
export const GET: RequestHandler = ({ request }) =>
  sseResponse(request, (signal) => gateway().watchOverview({}, { signal }), (update) => encode(ui.OverviewUpdateSchema, update));
