import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Threads of a project (main and side threads), for the thread tree on the thread page. */
export const GET: RequestHandler = async ({ params }) =>
  json(encode(ui.ListThreadsResponseSchema, await call((api) => api.listThreads({ projectId: params.projectId }))));
