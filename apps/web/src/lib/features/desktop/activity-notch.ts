import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { bots, ui } from "@canopy/contracts";
import { botParticipant } from "@canopy/domain/bot-chat";
import { sharesThreads } from "@canopy/domain/computer-presence";
import { REMOTE_BOTS } from "@canopy/domain/computers";
import { threadRowPlace } from "@canopy/domain/git-heads";
import { Provider } from "@canopy/contracts";
import { providerKeys } from "@canopy/ui/providers";
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

type Placement = Pick<ActivityNotchItem, "project" | "worker" | "place" | "branch" | "branchLabel" | "provider">;

type Identity = Pick<ActivityNotchItem, "title" | "botAppearance"> & Placement & { projectId?: string | undefined };

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

/** The sidebar row's facts: project, worker, directory, branch and provider (SidebarThread). */
function threadPlacement(thread: ui.Thread, project: ui.Project | undefined, worker: string | undefined): Placement {
  const { place, branch, branchLabel } = threadRowPlace(thread, project);
  const provider = providerKeys.find((key) => Provider[key] === thread.provider);

  return {
    ...(project?.name && { project: project.name }),
    ...(worker && { worker }),
    ...(place && { place }),
    ...(branch && { branch, branchLabel }),
    ...(provider && { provider }),
  };
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
  projectOf,
  workerOf,
  now,
}: {
  threads: ReadonlyMap<string, ui.Thread> | undefined;
  bots: readonly bots.Bot[];
  computers: ReadonlyMap<string, ui.LinkedComputer>;
  staleBotHomes: ReadonlySet<string>;
  botExecuting: (id: string) => boolean;
  markForProject: (id: string) => ActivityNotchProjectMark | undefined;
  projectOf: (id: string) => ui.Project | undefined;
  /** The worker the row names, or undefined when the sidebar row would not name one. */
  workerOf: (thread: ui.Thread) => string | undefined;
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
        ...threadPlacement(thread, projectOf(thread.projectId), workerOf(thread)),
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
    .map(({ path, state, title, projectId, botAppearance, project, worker, place, branch, branchLabel, provider }) => {
      const projectMark = projectId ? markForProject(projectId) : undefined;

      return {
        path,
        state,
        ...(title && { title }),
        ...(project && { project }),
        ...(worker && { worker }),
        ...(place && { place }),
        ...(branch && { branch, branchLabel }),
        ...(provider && { provider }),
        ...(projectMark && { projectMark }),
        ...(botAppearance && { botAppearance }),
      };
    });

  return { items, expiresAt };
}
