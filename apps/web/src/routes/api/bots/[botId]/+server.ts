import { json } from "@sveltejs/kit";
import { bots } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => json(encode(bots.GetBotResponseSchema, await call((api) => api.getBot({ botId: params.botId }))));
export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, bots.UpdateBotRequestSchema);
  return json(encode(bots.GetBotResponseSchema, await call((api) => api.updateBot({ ...body, botId: params.botId }))));
};
