import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, bots.MarkBotReadRequestSchema);
  return json(encode(bots.GetBotResponseSchema, await call((api) => api.markBotRead({ ...body, botId: params.botId }))));
};
