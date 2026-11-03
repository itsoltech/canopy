import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params }) => json(encode(bots.GetBotResponseSchema, await call((api) => api.archiveBot({ botId: params.botId }))));
export const DELETE: RequestHandler = async ({ params }) => json(encode(bots.GetBotResponseSchema, await call((api) => api.unarchiveBot({ botId: params.botId }))));
