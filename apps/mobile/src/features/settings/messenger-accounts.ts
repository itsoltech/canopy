import type { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

export type TokenMessenger = "telegram" | "discord";

const statuses = new Map(
  Object.entries({
    connected: "Connected",
    connecting: "Connecting…",
    retrying: "Reconnecting…",
    needs_authorization: "Authorization needed",
    needs_reconnect: "Reconnect needed",
    error: "Connection error",
    disconnected: "Disconnected",
  }),
);

/** The row status of a messenger account; a paused account reports that first. */
export const messengerStatus = (account: ui.MessengerAccount) =>
  !account.enabled ? "Paused" : (statuses.get(account.status) ?? "Waiting for connection");

/** Accounts saved before Telegram and Discord existed carry no provider and are Slack accounts. */
export const messengerProvider = (account: ui.MessengerAccount) => account.provider || "slack";

export const disconnectDescription =
  "This removes every message route using this account. To receive messages again, reconnect the bot and add its routes.";

/** The gateway's setup guidance for a rejected token or bot setup; other failures stay generic. */
export const messengerSetupFailure = (cause: unknown) => {
  const error = ConnectError.from(cause);

  return [Code.InvalidArgument, Code.FailedPrecondition].includes(error.code) ? error.rawMessage : undefined;
};

export const tokenMessengers: Record<
  TokenMessenger,
  {
    app: string;
    bot: string;
    title: string;
    description: string;
    setup: string[];
    setupTitle: string;
    setupUrl: string;
    placeholder?: string;
  }
> = {
  telegram: {
    app: "Telegram",
    bot: "Telegram Bot",
    title: "Telegram Bot accounts",
    description: "Receive and reply to Telegram messages as your bot.",
    setup: [
      "In Telegram, open @BotFather and send /newbot.",
      "Copy the token BotFather sends and paste it below.",
      "To receive group messages without mentions, send /setprivacy and turn Group Privacy off.",
    ],
    setupTitle: "Open BotFather",
    setupUrl: "https://t.me/BotFather",
    placeholder: "123456789:AA…",
  },
  discord: {
    app: "Discord",
    bot: "Discord Bot",
    title: "Discord Bot accounts",
    description: "Receive and reply to Discord messages as your bot.",
    setup: [
      "In the Discord Developer Portal, add a bot to your application.",
      "Turn on Message Content Intent, then reset and copy the bot token.",
      "Invite the bot with View Channels, Send Messages, Send Messages in Threads and Read Message History.",
    ],
    setupTitle: "Open Developer Portal",
    setupUrl: "https://discord.com/developers/applications",
  },
};
