import type { MessengerAdapter, MessengerProvider } from "./provider.ts";
import { discordAdapter } from "./discord.ts";
import { slackAdapter } from "./slack.ts";
import { telegramAdapter } from "./telegram.ts";

const adapters: Record<MessengerProvider, MessengerAdapter> = {
  slack: slackAdapter,
  telegram: telegramAdapter,
  discord: discordAdapter,
};

export const messengerAdapter = (provider: MessengerProvider): MessengerAdapter => adapters[provider];
