import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(encode(ui.GetThreadResponseSchema, await call((api) => api.getThread({ threadId: params.threadId }))));
