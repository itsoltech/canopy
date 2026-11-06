import { json, error } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url, request }) => {
  const before = url.searchParams.get("before") ?? "";

  if (!/^\d{1,18}$/.test(before)) error(400, "Invalid history position");
  const abort = new AbortController();

  try {
    for await (const page of gateway().watchBotConversation(
      {
        botId: params.botId,
        incremental: true,
        pageSize: 50,
        beforeSeq: BigInt(before),
        cursor: (url.searchParams.get("cursor") ?? "").slice(0, 256),
      },
      { signal: AbortSignal.any([request.signal, abort.signal]), timeoutMs: 15000 },
    )) {
      return json(encode(bots.BotConversationSchema, page));
    }

    error(503, "History unavailable");
  } finally {
    abort.abort();
  }
};
