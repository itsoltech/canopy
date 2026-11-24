import type { bots, ui } from "@canopy/contracts";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { needsYou, unseenResult } from "./thread-activity.ts";
import { isThreadSnoozed } from "./thread-snooze.ts";

export const maxNotificationBadge = 9999;

export function threadBadgeCount(threads: ReadonlyMap<string, ui.Thread>, localOnly = false): number {
  let count = 0;

  for (const thread of threads.values()) {
    if (
      thread.archivedAt ||
      thread.status === "archived" ||
      thread.deletedAt ||
      thread.spawnedByAgent ||
      (localOnly && thread.nodeId) ||
      (!needsYou(thread) && (!unseenResult(thread) || thread.interruptedByUser)) ||
      isThreadSnoozed(thread, (id) => threads.get(id))
    )
      continue;
    count++;
  }

  return count;
}

export function botBadgeCount(bots: readonly bots.Bot[], localOnly = false): number {
  const now = Date.now();
  let count = 0;

  for (const bot of bots) {
    if (bot.archived || (localOnly && bot.nodeId)) continue;
    count += bot.unreadCount;
    const card = bot.pendingApproval;

    // A projected thread request already belongs to its thread.
    if (card?.status === "pending" && !card.threadId && (!card.expiresAt || timestampMs(card.expiresAt) > now)) count++;
  }

  return count;
}
