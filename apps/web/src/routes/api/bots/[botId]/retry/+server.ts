import { json } from "@sveltejs/kit";
import { bots } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  await readMessage(request, bots.RetryBotRequestSchema);
  return json(encode(bots.RetryBotResponseSchema, await call((api) => api.retryBot({ botId: params.botId }))));
};
