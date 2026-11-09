import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { bots } from "@canopy/contracts";

export type BotEvent =
  | { kind: "message"; message: bots.BotMessage }
  | { kind: "approval" | "answer"; approval: bots.BotApproval };

export interface BotSeen {
  readonly seq: bigint;
  readonly approvalAt: number;
}

const approvalAt = (bot: bots.Bot) => (bot.pendingApproval?.createdAt ? timestampMs(bot.pendingApproval.createdAt) : 0);

const fresh = (at: Parameters<typeof timestampMs>[0] | undefined, now: number) =>
  at !== undefined && now - timestampMs(at) < 10 * 60_000;

/** Max cursors survive partial bot updates; the first complete list is a silent baseline. */
export function botSeen(before: BotSeen | undefined, bot: bots.Bot): BotSeen {
  const seq = bot.lastMessage?.seq ?? 0n;

  return {
    seq: before && before.seq > seq ? before.seq : seq,
    approvalAt: Math.max(before?.approvalAt ?? 0, approvalAt(bot)),
  };
}

/** A fresh owner-facing card takes precedence over a fresh message. Archived bots stay quiet. */
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
