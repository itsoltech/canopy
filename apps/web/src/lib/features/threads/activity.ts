import type { ui } from "@open-agents/contracts";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

/** Last change of a thread (created, turn queued, started or finished). */
export const activityOf = (thread: ui.Thread): Timestamp | undefined => thread.lastActivityAt ?? thread.createdAt;
const seconds = (thread: ui.Thread) => activityOf(thread)?.seconds ?? 0n;

/** Most recent first. */
export const byActivity = (a: ui.Thread, b: ui.Thread) => Number(seconds(b) - seconds(a));

/** Latest activity of a main thread and its side threads, for ordering trees. */
export const treeActivity = (threads: readonly ui.Thread[]): bigint => threads.reduce((max, t) => (seconds(t) > max ? seconds(t) : max), 0n);

const waiting = (thread: ui.Thread) => thread.status === "waiting_input" || thread.pendingInteractions > 0;

/** Waits for a person: an approval or question routed to the user. */
export const needsYou = (thread: ui.Thread) => waiting(thread) && thread.interactionRoute !== "parent";

/** Waits for its parent agent's answer (interaction_route = parent); the user may still step in. */
export const asksAgent = (thread: ui.Thread) => waiting(thread) && thread.interactionRoute === "parent";

/**
 * What a thread is doing right now, for the activity mark in lists: waiting for you or its agent first,
 * then a running or starting turn, then background tasks alone; "idle" covers finished, failed and the rest.
 */
export type WorkState = "needs" | "asks" | "starting" | "running" | "background" | "idle";

export function workState(thread: ui.Thread): WorkState {
  if (needsYou(thread)) return "needs";
  if (asksAgent(thread)) return "asks";
  if (thread.status === "creating") return "starting";
  if (thread.status === "running") return "running";
  return thread.backgroundTasks > 0 ? "background" : "idle";
}

/** A turn runs, the thread starts or a background task still runs. */
export const isWorking = (thread: ui.Thread) => ["starting", "running", "background"].includes(workState(thread));
