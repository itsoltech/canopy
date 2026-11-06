import { bots } from "@canopy/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request }) => {
  return sseResponse(
    request,
    async function* (signal) {
      await gateway().getBot({ botId: params.botId }, { signal });
      yield* gateway().watchBotConversation({ botId: params.botId }, { signal, timeoutMs: 0 });
    },
    (snapshot) => encode(bots.BotConversationSchema, snapshot),
  );
};
