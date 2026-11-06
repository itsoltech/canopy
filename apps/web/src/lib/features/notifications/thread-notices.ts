import type { ui } from "@canopy/contracts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { needsYou, unseenResult, type TurnResult } from "#lib/features/threads/activity.ts";
import type { Notice } from "./deliver.ts";

export type ThreadEvent = "completed" | "failed" | "stopped" | "approval" | "answer";

const busy = (thread: ui.Thread) => thread.status === "running" || thread.status === "creating";

const results = { completed: "completed", failed: "failed", interrupted: "stopped" } satisfies Record<
  TurnResult,
  ThreadEvent
>;

/**
 * Snapshots/reconnects establish a baseline; only live transitions of already visible threads alert.
 * A result alerts once, when its turn ends: a new turn starting next to an unseen result does not.
 * A turn the user stopped does not alert.
 */
export function notificationEvent(before: ui.Thread | undefined, next: ui.Thread): ThreadEvent | undefined {
  if (!before || next.deletedAt || next.status === "archived") return;

  if (needsYou(next) && (!needsYou(before) || next.pendingInteractions > before.pendingInteractions))
    return next.noticeInteractionKind === "permission" ? "approval" : "answer";

  if (busy(next) || next.interruptedByUser) return;
  const result = unseenResult(next);

  return result && (result !== before.unseenResult || busy(before)) ? results[result] : undefined;
}

const status: Record<ThreadEvent, { body: string; toast: string }> = {
  completed: { body: "Finished", toast: "finished" },
  failed: { body: "Failed", toast: "failed" },
  stopped: { body: "Stopped", toast: "stopped" },
  approval: { body: "Needs your approval", toast: "needs your approval" },
  answer: { body: "Needs your answer", toast: "needs your answer" },
};

/** The same event of a thread mirrored from a linked computer has the same key as on its home. */
export const baseId = (id: string) => id.split("~", 1)[0] ?? id;

/** Where the thread lives, so threads with similar titles stay apart: its project, and the computer if linked. */
function place(overview: OverviewState, thread: ui.Thread): string {
  const project = overview.project(thread.projectId);
  const name = project && project.kind !== "scratch" ? project.name : "";
  const machine = overview.machine(thread.nodeId);

  if (name && machine) return `${name} on ${machine}`;

  return name || machine || "";
}

export function threadNotice(overview: OverviewState, thread: ui.Thread, event: ThreadEvent): Notice {
  const title = thread.title || "Untitled thread";
  const where = place(overview, thread);
  const headline = where ? `${status[event].body} · ${where}` : status[event].body;

  return {
    key: `thread:${baseId(thread.id)}:${event}:${thread.lastSeq}:${thread.pendingInteractions}`,
    setting: "threadNotifications",
    path: `/threads/${encodeURIComponent(thread.id)}`,
    title,
    body: thread.noticePreview ? `${headline}\n${thread.noticePreview}` : headline,
    toast: `“${title}” ${status[event].toast}.`,
    action: "Open thread",
    tone: event === "failed" ? "error" : "info",
  };
}
