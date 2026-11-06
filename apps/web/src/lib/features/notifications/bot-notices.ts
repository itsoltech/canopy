import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { bots } from "@canopy/contracts";
import { noticePreview } from "@canopy/domain/notice-preview";
import { displayText } from "#lib/features/bots/live.ts";
import type { Notice } from "./deliver.ts";
import { baseId } from "./thread-notices.ts";

/** Older events (a linked computer catching up, a list loaded after a long sleep) are history, not news. */
const FRESH_MS = 10 * 60_000;

export type BotEvent =
  | { kind: "message"; message: bots.BotMessage }
  | { kind: "approval" | "answer"; approval: bots.BotApproval };

const fresh = (at: Parameters<typeof timestampMs>[0] | undefined, now: number) =>
  at !== undefined && now - timestampMs(at) < FRESH_MS;

/** What this device already knows of a bot: its newest message and card (GetBot answers carry neither). */
export interface BotSeen {
  readonly seq: bigint;
  readonly approvalAt: number;
}

const approvalAt = (bot: bots.Bot) => (bot.pendingApproval?.createdAt ? timestampMs(bot.pendingApproval.createdAt) : 0);

export function botSeen(before: BotSeen | undefined, bot: bots.Bot): BotSeen {
  const seq = bot.lastMessage?.seq ?? 0n;

  return {
    seq: before && before.seq > seq ? before.seq : seq,
    approvalAt: Math.max(before?.approvalAt ?? 0, approvalAt(bot)),
  };
}

/**
 * What changed for the owner since the previous list: a new card waiting for them first, then a new message to
 * them (a reply, a routine's message_user, a reminder, a bot-to-bot exchange answer). The first list is the baseline.
 */
export function botEvent(before: BotSeen | undefined, next: bots.Bot, now: number): BotEvent | undefined {
  if (!before || next.archived) return;
  const approval = next.pendingApproval;

  if (approval && approvalAt(next) > before.approvalAt && fresh(approval.createdAt, now))
    return { kind: approval.kind === "question" ? "answer" : "approval", approval };
  const message = next.lastMessage;

  if (
    message &&
    message.seq > before.seq &&
    message.senderId === next.id &&
    message.recipientId === "user" &&
    message.kind === "message" &&
    !message.failed &&
    fresh(message.createdAt, now)
  )
    return { kind: "message", message };

  return undefined;
}

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
