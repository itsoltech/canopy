import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Active index with Previous agents; the archive itself is paged separately. */
export const GET: RequestHandler = async ({ url }) => {
  return json(encode(ui.ListThreadsResponseSchema, await call((api) => api.listThreads({ projectId: url.searchParams.get("projectId") ?? "", sidebarOnly: true }))));
};
