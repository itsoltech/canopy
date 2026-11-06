import type { PageLoad } from "./$types";
import { botCache } from "#lib/features/bots/cache.ts";
import { botList } from "#lib/features/bots/bot-list.svelte.ts";
import { botViewKey } from "@canopy/domain/bot-cache";
import { bots } from "@canopy/contracts";
import { decode } from "#lib/shared/wire.ts";
import { bodyJson } from "#lib/shared/json.ts";

export const load: PageLoad = async ({ params, fetch }) => {
  const exchange = (await botCache.load(botViewKey("exchange", params.exchangeId)))?.exchange;
  const known = [...botList.list, ...(exchange?.participants ?? [])];

  if (!known.some((bot) => bot.id === params.botId)) {
    const response = await fetch(`/api/bots/${params.botId}`);

    if (!response.ok) throw new Error("Could not load this bot");
    const result = decode(bots.GetBotResponseSchema, await bodyJson(response));

    if (result.bot) known.push(result.bot);
  }

  return { exchange, bots: known };
};
