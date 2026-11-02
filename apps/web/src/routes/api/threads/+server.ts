import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Every thread of the user (thread inbox), for resynchronising after the live stream reconnects. */
export const GET: RequestHandler = async ({ url }) => {
  return json(encode(ui.ListThreadsResponseSchema, await call((api) => api.listThreads({ projectId: url.searchParams.get("projectId") ?? "", includeArchived: true }))));
};
