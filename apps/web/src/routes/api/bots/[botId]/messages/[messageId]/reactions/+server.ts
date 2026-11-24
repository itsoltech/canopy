import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, bots.SetBotMessageReactionRequestSchema);
  await call((api) => api.setBotMessageReaction({ ...body, botId: params.botId, messageId: params.messageId }));

  return json({});
};
