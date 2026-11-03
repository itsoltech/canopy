import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  await readMessage(request, bots.InterruptBotRequestSchema);
  return json(encode(bots.InterruptBotResponseSchema, await call((api) => api.interruptBot({ botId: params.botId }))));
};
