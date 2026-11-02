import { json } from "@sveltejs/kit";
import { bots } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => json(encode(bots.ReadBotExchangeResponseSchema, await call((api) => api.readBotExchange({ exchangeId: params.exchangeId }))));
