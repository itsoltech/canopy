import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) =>
  json(
    encode(
      bots.ListBotsResponseSchema,
      await call((api) => api.listBots({ includeArchived: url.searchParams.get("archived") === "1" })),
    ),
  );

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, bots.CreateBotRequestSchema);

  return json(encode(bots.GetBotResponseSchema, await call((api) => api.createBot(body))));
};
