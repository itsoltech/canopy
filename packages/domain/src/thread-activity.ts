import type { ui } from "@canopy/contracts";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { formatAge } from "./relative-time.ts";

/** Last change of a thread (created, turn queued, started or finished). */
export const activityOf = (thread: ui.Thread): Timestamp | undefined => thread.lastActivityAt ?? thread.createdAt;

/** The compact working label uses the same rounded age as quiet list rows. */
export function workingLabel(thread: ui.Thread, now = Date.now()): string {
  const age = formatAge(activityOf(thread), now);

  return age && age !== "now" ? `Working ${age}` : "Working";
}

/** Current list status; clients can keep a just-seen result visible briefly without changing these rules. */
export function threadRowLabel(thread: ui.Thread, now = Date.now()): string {
  const state = workState(thread);

  if (state === "needs") return "Needs input";

  if (state === "asks") return "Asking agent";

  if (state === "starting") return "Starting";

  if (state === "running") return workingLabel(thread, now);
  const result = unseenResult(thread) ?? (thread.status === "failed" ? "failed" : undefined);

  return result ? result[0]!.toUpperCase() + result.slice(1) : formatAge(activityOf(thread), now);
}

const seconds = (thread: ui.Thread) => activityOf(thread)?.seconds ?? 0n;

/** Most recent first. */
export const byActivity = (a: ui.Thread, b: ui.Thread) => Number(seconds(b) - seconds(a));

/** Latest activity of a main thread and its side threads, for ordering trees. */
export const treeActivity = (threads: readonly ui.Thread[]): bigint =>
  threads.reduce((max, t) => (seconds(t) > max ? seconds(t) : max), 0n);

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

  if (thread.status === "creating" || thread.turnStarting) return "starting";

  if (thread.status === "running") return "running";

  return thread.backgroundTasks > 0 ? "background" : "idle";
}

/** How a finished turn ended, while the user has not seen it (Thread.unseen_result). */
export type TurnResult = "completed" | "failed" | "interrupted";

const results: readonly string[] = ["completed", "failed", "interrupted"] satisfies TurnResult[];

const isTurnResult = (value: string): value is TurnResult => results.includes(value);

export const unseenResult = (thread: ui.Thread): TurnResult | undefined =>
  isTurnResult(thread.unseenResult) ? thread.unseenResult : undefined;

/**
 * Busy without needing anyone: a turn running or starting, asking its agent, or background tasks alone with
 * nothing new to look at. Lists keep normal text contrast and show activity through the status and mark.
 */
export function isCalm(thread: ui.Thread): boolean {
  const state = workState(thread);

  return (
    state === "starting" || state === "running" || state === "asks" || (state === "background" && !unseenResult(thread))
  );
}
