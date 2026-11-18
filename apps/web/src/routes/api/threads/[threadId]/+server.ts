import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request }) =>
  json(encode(ui.GetThreadResponseSchema, await call(() => bffSession().thread(params.threadId, request.signal))));
