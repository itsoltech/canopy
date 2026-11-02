import { bots } from "@open-agents/contracts";
import { call, gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request }) => {
  await call((api) => api.getBot({ botId: params.botId }, { signal: request.signal }));
  return sseResponse(request, (signal) => gateway().watchBotConversation({ botId: params.botId }, { signal, timeoutMs: 0 }), (snapshot) => encode(bots.BotConversationSchema, snapshot));
};
