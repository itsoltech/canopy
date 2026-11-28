import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, bots.SetBotTriggerEnabledRequestSchema);

  return json(
    encode(
      bots.BotTriggerResponseSchema,
      await call((api) => api.setBotTriggerEnabled({ ...body, botId: params.botId, triggerId: params.triggerId })),
    ),
  );
};

export const DELETE: RequestHandler = async ({ params }) => {
  await call((api) => api.deleteBotTrigger({ botId: params.botId, triggerId: params.triggerId }));

  return json({});
};
