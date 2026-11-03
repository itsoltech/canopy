import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => json(encode(ui.ListArchivedThreadsResponseSchema, await call((api) => api.listArchivedThreads({
  projectIds: url.searchParams.getAll("projectId"),
  query: url.searchParams.get("q") ?? "",
  pageToken: url.searchParams.get("pageToken") ?? "",
  pageSize: 20,
  countOnly: url.searchParams.get("countOnly") === "true",
}))));
