import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessengerMessage } from "#lib/server/messenger-body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(
      ui.ListBotMessengerRoutesResponseSchema,
      await call((api) => api.listBotMessengerRoutes({ botId: params.botId })),
    ),
  );

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessengerMessage(request, ui.SaveBotMessengerRouteRequestSchema);

  if (body.route) body.route.botId = params.botId;

  return json(encode(ui.SaveBotMessengerRouteResponseSchema, await call((api) => api.saveBotMessengerRoute(body))));
};
