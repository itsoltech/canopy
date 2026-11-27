import type { MessengerProvider } from "./provider.ts";
import type { MessengerCredentials } from "./types.ts";

const telegramToken = /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/;
const discordToken = /^[A-Za-z0-9_-]{20,100}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,100}$/;
const slackBotToken = /^(xoxb-|xoxe\.xoxb-)[^\s]+$/;

/** Returns the owner-facing reason when saved tokens cannot belong to the account's provider. */
export function invalidMessengerTokens(
  provider: MessengerProvider,
  credentials: MessengerCredentials,
  linkedConnector: boolean,
): string | undefined {
  if (provider === "telegram")
    return !credentials.appToken && telegramToken.test(credentials.botToken)
      ? undefined
      : "Paste the bot token from BotFather";

  if (provider === "discord")
    return !credentials.appToken && discordToken.test(credentials.botToken)
      ? undefined
      : "Paste the bot token from the Discord Developer Portal";

  const appToken = /^xapp-[^\s]+$/.test(credentials.appToken) && credentials.appToken.length <= 4096;
  const botToken = linkedConnector || (slackBotToken.test(credentials.botToken) && credentials.botToken.length <= 4096);

  return appToken && botToken ? undefined : "Slack app token is required; manual accounts also need a bot token";
}

const identityNames: Record<MessengerProvider, string> = {
  slack: "Slack workspace",
  telegram: "Telegram bot",
  discord: "Discord bot",
};

/** What one external ID identifies, for duplicate and reconnect errors. */
export const messengerIdentityName = (provider: MessengerProvider) => identityNames[provider];
