import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { bots, ui } from "@canopy/contracts";
import { botParticipant } from "@canopy/domain/bot-chat";
import { sharesThreads } from "@canopy/domain/computer-presence";
import { REMOTE_BOTS } from "@canopy/domain/computers";
import { headLabel } from "@canopy/domain/git-heads";
import { HARNESS_NAMES, harnessOf } from "@canopy/domain/harnesses";
import { activityOf, unseenResult, workState } from "@canopy/domain/thread-activity";
import { isThreadSnoozed } from "@canopy/domain/thread-snooze";
import {
  isDesktopActivityRoute,
  maxActivityNotchItems,
  type ActivityNotchItem,
  type ActivityNotchProjectMark,
} from "@canopy/ui/desktop";

type Activity = {
  state: ActivityNotchItem["state"];
  at: number;
  expiresAt?: number;
};

type Identity = Pick<ActivityNotchItem, "title" | "detail" | "botAppearance"> & { projectId?: string | undefined };

const priority: Record<ActivityNotchItem["state"], number> = {
  approval: 0,
  answer: 0,
  failed: 1,
  working: 2,
  completed: 3,
};

const recentFailureMs = 10 * 60_000;
const time = (timestamp: Timestamp | undefined): number => (timestamp ? timestampMs(timestamp) : 0);

function threadActivity(thread: ui.Thread): Activity | undefined {
  const at = time(activityOf(thread));
  const work = workState(thread);

  if (work === "needs" || (thread.hasPendingRequests && thread.interactionRoute !== "parent"))
    return { state: thread.noticeInteractionKind === "permission" ? "approval" : "answer", at };

  if (work === "starting" || work === "running" || work === "background") return { state: "working", at };
  const result = unseenResult(thread);

  if (result === "failed" || result === "completed") return { state: result, at };

  return undefined;
}

/** Where the thread runs: its agent, worker and branch, as in the thread's hover card. */
function threadDetail(thread: ui.Thread, place: string | undefined): string | undefined {
  const harness = harnessOf(thread.provider);
  const head = thread.worktree ?? thread.checkoutHead;
  const branch = head && (head.branch || head.detachedCommit) ? headLabel(head) : undefined;

  return [harness && HARNESS_NAMES[harness], place, branch].filter(Boolean).join(" · ") || undefined;
}

function botActivity(bot: bots.Bot, executing: boolean, now: number): Activity | undefined {
  const card = bot.pendingApproval;

  // A projected thread request belongs to the thread, with its own snooze and module rules.
  if (card?.status === "pending" && !card.threadId) {
    const expiresAt = card.expiresAt ? time(card.expiresAt) : Infinity;

    if (expiresAt > now)
      return { state: card.kind === "question" ? "answer" : "approval", at: time(card.createdAt), expiresAt };
  }

  if (executing) return { state: "working", at: time(bot.updatedAt) };
  const message = bot.lastMessage;
  const at = time(message?.createdAt ?? bot.updatedAt);
  const expiresAt = at + recentFailureMs;

  if (message?.failed && message.recipientId === "user" && message.seq > bot.lastReadSeq && expiresAt > now)
    return { state: "failed", at, expiresAt };

  return bot.unreadCount > 0 ? { state: "completed", at } : undefined;
}

export function activityNotchSnapshot({
  threads,
  bots,
  computers,
  staleBotHomes,
  botExecuting,
  markForProject,
  placeOf,
  now,
}: {
  threads: ReadonlyMap<string, ui.Thread> | undefined;
  bots: readonly bots.Bot[];
  computers: ReadonlyMap<string, ui.LinkedComputer>;
  staleBotHomes: ReadonlySet<string>;
  botExecuting: (id: string) => boolean;
  markForProject: (id: string) => ActivityNotchProjectMark | undefined;
  /** The worker's name, or the linked computer's when its workers are not listed here. */
  placeOf: (thread: ui.Thread) => string | undefined;
  now: number;
}) {
  const activities: (Activity & Identity & { path: string })[] = [];
  let expiresAt = Infinity;

  function add(path: string, activity: Activity | undefined, identity: Identity) {
    if (!activity || !isDesktopActivityRoute(path)) return;
    activities.push({ path, ...activity, ...identity });
    expiresAt = Math.min(expiresAt, activity.expiresAt ?? Infinity);
  }

  const connectedHome = (nodeId: string) => {
    const computer = computers.get(nodeId);

    return computer && !computer.unavailableReason && sharesThreads(computer) ? computer : undefined;
  };

  if (threads)
    for (const thread of threads.values()) {
      if (
        thread.spawnedByAgent ||
        thread.deletedAt ||
        thread.archivedAt ||
        thread.status === "archived" ||
        (thread.nodeId && !connectedHome(thread.nodeId)) ||
        isThreadSnoozed(thread, (id) => threads.get(id))
      )
        continue;
      add(`/threads/${thread.id}`, threadActivity(thread), {
        title: thread.title,
        detail: threadDetail(thread, placeOf(thread)),
        projectId: thread.projectId,
      });
    }

  for (const bot of bots) {
    if (bot.archived) continue;

    if (bot.nodeId && (staleBotHomes.has(bot.nodeId) || !connectedHome(bot.nodeId)?.capabilities.includes(REMOTE_BOTS)))
      continue;
    const { name, shape, color } = botParticipant(bot);
    add(`/bots/${bot.id}`, botActivity(bot, botExecuting(bot.id), now), {
      title: name,
      botAppearance: { ...(shape && { shape }), ...(color && { color }) },
    });
  }

  activities.sort((a, b) => priority[a.state] - priority[b.state] || b.at - a.at || a.path.localeCompare(b.path));

  const items: ActivityNotchItem[] = activities
    .slice(0, maxActivityNotchItems)
    .map(({ path, state, title, detail, projectId, botAppearance }) => {
      const projectMark = projectId ? markForProject(projectId) : undefined;

      return {
        path,
        state,
        ...(title && { title }),
        ...(detail && { detail }),
        ...(projectMark && { projectMark }),
        ...(botAppearance && { botAppearance }),
      };
    });

  return { items, expiresAt };
}
