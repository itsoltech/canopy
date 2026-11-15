import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const archived = url.searchParams.get("archived") === "1";
  const key = archived ? "ListBots:archived" : "ListBots";

  return json(
    encode(
      bots.ListBotsResponseSchema,
      await call((api) =>
        bffSession().reads.read(key, bots.ListBotsResponseSchema, () => api.listBots({ includeArchived: archived })),
      ),
    ),
  );
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, bots.CreateBotRequestSchema);

  const value = await call(async (api) => {
    const session = bffSession();
    const created = await api.createBot(body);
    session.reads.invalidate("ListBots");
    session.reads.invalidate("ListBots:archived");

    return created;
  });

  return json(encode(bots.GetBotResponseSchema, value));
};
