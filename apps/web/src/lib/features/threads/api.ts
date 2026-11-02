import { ui } from "@open-agents/contracts";
import type { PermissionModeKey } from "./labels.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import type { Mention } from "@open-agents/contracts";
import { mentionsToWire } from "#lib/features/mentions/wire.ts";
import type { WireQuote } from "#lib/features/quotes/quote.ts";

/** Browser-side calls to the BFF (same origin, JSON). */
const post = (path: string, body: unknown) => requestJson("POST", path, body);
const threadPath = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}`;

/** queue: the next turn; steer: into the running turn (without one the gateway queues it too). */
export type Delivery = "queue" | "steer";

/**
 * A message: `turn` when it became a turn (queued, also a steer without a running turn), `steer` when it
 * joins the running turn. `model` / `effort` / `permissionMode`: this turn only (unset = the thread's defaults; a
 * steer runs in the mode of the turn it joins). `quotes`: passages of the thread it quotes (quote drafts), steer too.
 */
export async function sendMessage(
  threadId: string,
  text: string,
  clientRequestId: string,
  turn: { model?: string; effort?: string; permissionMode?: PermissionModeKey } = {},
  delivery: Delivery = "queue",
  attachmentIds: readonly string[] = [],
  mentions: readonly Mention[] = [],
  quotes: readonly WireQuote[] = [],
): Promise<ui.SendMessageResponse> {
  return decode(
    ui.SendMessageResponseSchema,
    await post(`${threadPath(threadId)}/messages`, {
      text,
      clientRequestId,
      ...turn,
      delivery,
      ...(attachmentIds.length > 0 && { attachmentIds }),
      ...(mentions.length > 0 && { mentions: mentionsToWire(mentions) }),
      ...(quotes.length > 0 && { quotes }),
    }),
  );
}

/** The thread's default model, effort and permission mode: unset = unchanged, "" = the profile's default. */
export async function updateThread(
  threadId: string,
  change: { model?: string; effort?: string; permissionMode?: PermissionModeKey },
): Promise<ui.Thread | undefined> {
  return decode(ui.UpdateThreadResponseSchema, await post(`${threadPath(threadId)}/settings`, change)).thread;
}

export async function interruptThread(threadId: string): Promise<void> {
  await post(`${threadPath(threadId)}/interrupt`, {});
}

export async function answerInteraction(
  requestId: string,
  answer: { allow?: boolean; allowForSession?: boolean; message?: string; answerJson?: string; cancelled?: boolean },
): Promise<void> {
  await post(`/api/interactions/${encodeURIComponent(requestId)}`, answer);
}

/** Stops a running background task (the `background_task` item's id); the item ends as interrupted. */
export async function stopBackgroundTask(threadId: string, itemId: string): Promise<void> {
  await post(`${threadPath(threadId)}/background-tasks/stop`, { itemId });
}
