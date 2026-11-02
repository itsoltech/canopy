import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Directory listing on a worker, limited by the worker to its allowed roots. */
export const GET: RequestHandler = async ({ params, url }) => {
  const path = url.searchParams.get("path") ?? "";
  const response = await call((api) => api.listDirectory({ workerId: params.workerId, path }, { timeoutMs: 20_000 }));
  return json(encode(ui.ListDirectoryResponseSchema, response));
};
