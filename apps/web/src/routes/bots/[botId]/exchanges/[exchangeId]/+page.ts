import { error } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { decode } from "#lib/shared/wire.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const [exchange, list] = await Promise.all([fetch(`/api/bot-exchanges/${params.exchangeId}`), fetch("/api/bots?archived=1")]);
  if (!exchange.ok || !list.ok) error(exchange.ok ? list.status : exchange.status, "Could not load this conversation");
  return {
    messages: decode(bots.ReadBotExchangeResponseSchema, await exchange.json()).messages,
    bots: decode(bots.ListBotsResponseSchema, await list.json()).bots,
  };
};
