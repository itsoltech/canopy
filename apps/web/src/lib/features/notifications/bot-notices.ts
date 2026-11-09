import type { bots } from "@canopy/contracts";
import type { BotEvent } from "@canopy/domain/bot-chat";

export { botEvent, botSeen, type BotEvent, type BotSeen } from "@canopy/domain/bot-chat";

import { noticePreview } from "@canopy/domain/notice-preview";
import { displayText } from "#lib/features/bots/live.ts";
import type { Notice } from "./deliver.ts";
import { baseId } from "./thread-notices.ts";

export function botNotice(bot: bots.Bot, event: BotEvent): Notice {
  const name = bot.configuration?.name || "Bot";
  const common = { setting: "botNotifications", path: `/bots/${encodeURIComponent(bot.id)}`, title: name } as const;

  if (event.kind === "message")
    return {
      ...common,
      key: `bot:${baseId(bot.id)}:message:${event.message.seq}`,
      body: noticePreview(displayText(event.message)) || "New message",
      toast: `“${name}” sent a message.`,
      read: bot.unreadCount === 0,
      action: "Open chat",
      tone: "info",
    };
  const { approval } = event;
  const headline = event.kind === "approval" ? "Needs your approval" : "Needs your answer";
  const routine = approval.routineTitle ? `${headline} · From routine “${approval.routineTitle}”` : headline;

  // An approval prompt is "Needs approval · <action>" plus argument lines: the notice shows only the action.
  const asked =
    event.kind === "approval"
      ? (approval.prompt.split("\n", 1)[0] ?? "").replace(/^Needs approval · /, "")
      : approval.prompt;

  const preview = noticePreview(asked);

  return {
    ...common,
    key: `bot:${baseId(bot.id)}:${event.kind}:${baseId(approval.id)}`,
    body: preview ? `${routine}\n${preview}` : routine,
    toast: `“${name}” ${headline.toLowerCase()}.`,
    action: "Open chat",
    tone: "info",
  };
}
