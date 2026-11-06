import { error } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { decode } from "#lib/shared/wire.ts";
import type { PageLoad } from "./$types";
import { botCache } from "#lib/features/bots/cache.ts";
import { botList } from "#lib/features/bots/bot-list.svelte.ts";
import { botViewKey } from "@canopy/domain/bot-cache";

export const load: PageLoad = async ({ fetch, params }) => {
  await botCache.load(botViewKey("chat", params.botId));

  const bot =
    botList.list.find((bot) => bot.id === params.botId) ??
    botCache.get(botViewKey("chat", params.botId))?.conversation?.bot;

  if (bot) return { bot };
  const response = await fetch(`/api/bots/${params.botId}`);

  if (!response.ok) error(response.status, "Could not load this bot");

  return { bot: decode(bots.GetBotResponseSchema, await response.json()).bot! };
};
