import { error } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { decode } from "#lib/shared/wire.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const response = await fetch(`/api/bots/${params.botId}`);

  if (!response.ok) error(response.status, "Could not load this bot");

  return { bot: decode(bots.GetBotResponseSchema, await response.json()).bot! };
};
