import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { listAllThreads } from "#lib/server/threads.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Threads of every project (thread inbox), for resynchronising after the live stream reconnects. */
export const GET: RequestHandler = async () => {
  const overview = await call((api) => api.getOverview({}));
  return json(encode(ui.ListThreadsResponseSchema, await listAllThreads(overview.projects)));
};
