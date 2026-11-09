import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(encode(bots.BotComposerDraftSchema, await call((api) => api.getBotDraft({ botId: params.botId }))));

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, bots.SaveBotDraftRequestSchema);

  return json(
    encode(bots.BotComposerDraftSchema, await call((api) => api.saveBotDraft({ ...body, botId: params.botId }))),
  );
};
