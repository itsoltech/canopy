import type { ui } from "@canopy/contracts";

export type MessengerProvider = "slack" | "telegram" | "discord";

interface ProviderCopy {
  label: string;
  account: string;
  channelPattern: RegExp;
  userPattern: RegExp;
  channelPlaceholder: string;
  userPlaceholder: string;
  channelDescription: string;
  /** Owner-facing steps that end with a token to paste. Slack has its own manifest flow. */
  setup: readonly string[];
  tokenPlaceholder: string;
}

const copy: Record<MessengerProvider, ProviderCopy> = {
  slack: {
    label: "Slack",
    account: "Slack Bot",
    channelPattern: /^[CG][A-Z0-9]+$/,
    userPattern: /^[UW][A-Z0-9]+$/,
    channelPlaceholder: "C0123456789, G9876543210",
    userPlaceholder: "U0123456789, U9876543210",
    channelDescription: "Invite the app to each channel and separate its channel IDs with commas.",
    setup: [],
    tokenPlaceholder: "xoxb-…",
  },
  telegram: {
    label: "Telegram",
    account: "Telegram Bot",
    channelPattern: /^-\d+$/,
    userPattern: /^\d+$/,
    channelPlaceholder: "-1001234567890",
    userPlaceholder: "123456789, 987654321",
    channelDescription: "Add the bot to each group and separate group chat IDs with commas.",
    setup: [
      "In Telegram, open @BotFather and send /newbot.",
      "Copy the token BotFather sends and paste it below.",
      "To receive group messages without mentions, send /setprivacy and turn Group Privacy off.",
    ],
    tokenPlaceholder: "123456789:AA…",
  },
  discord: {
    label: "Discord",
    account: "Discord Bot",
    channelPattern: /^\d{17,20}$/,
    userPattern: /^\d{17,20}$/,
    channelPlaceholder: "123456789012345678",
    userPlaceholder: "123456789012345678",
    channelDescription:
      "Invite the bot to the server and separate channel IDs with commas. Threads follow their channel.",
    setup: [
      "In the Discord Developer Portal, add a bot to your application.",
      "Turn on Message Content Intent, then reset and copy the bot token.",
      "Invite the bot with View Channels, Send Messages, Send Messages in Threads and Read Message History.",
    ],
    tokenPlaceholder: "Bot token",
  },
};

export function providerOf(account: Pick<ui.MessengerAccount, "provider"> | undefined): MessengerProvider {
  return account?.provider === "telegram" || account?.provider === "discord" ? account.provider : "slack";
}

export const providerCopy = (provider: MessengerProvider) => copy[provider];

/** Parses comma-separated IDs in the account provider's format. */
export function messengerIds(text: string, kind: "channel" | "user", provider: MessengerProvider): string[] {
  const values = [
    ...new Set(
      text
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];

  const { label, channelPattern, userPattern } = copy[provider];
  const pattern = kind === "channel" ? channelPattern : userPattern;

  if (values.some((value) => !pattern.test(value)))
    throw new Error(`Some ${label} ${kind} IDs are invalid. Separate valid IDs with commas.`);

  if (kind === "user" && !values.length) throw new Error(`No allowed users yet. Add a ${label} user ID before saving.`);

  return values;
}
