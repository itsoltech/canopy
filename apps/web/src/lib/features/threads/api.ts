import { ui } from "@canopy/contracts";
import type { PermissionModeKey } from "./labels.ts";
import { requestJson, HttpError, type JsonBody } from "#lib/shared/http.ts";
import { isJsonObject } from "#lib/shared/json.ts";
import { resolvePendingSend } from "@canopy/domain/pending-send";
import { decode } from "#lib/shared/wire.ts";
import type { Mention } from "@canopy/contracts";
import { mentionsToWire } from "#lib/features/mentions/wire.ts";
import type { WireQuote } from "#lib/features/quotes/quote.ts";

/** Browser-side calls to the BFF (same origin, JSON). */
const post = (path: string, body: JsonBody) => requestJson("POST", path, body);
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
  onWaiting?: () => void,
  pending?: { signal: AbortSignal; beforeAttempt: () => Promise<void> },
): Promise<ui.SendMessageResponse> {
  const body = {
    text,
    clientRequestId,
    ...turn,
    delivery,
    ...(attachmentIds.length > 0 && { attachmentIds }),
    ...(mentions.length > 0 && { mentions: mentionsToWire(mentions) }),
    ...(quotes.length > 0 && { quotes }),
  };

  return resolvePendingSend(
    async () => {
      await pending?.beforeAttempt();
      const result = await post(`${threadPath(threadId)}/messages`, body);

      return isJsonObject(result) && result["pending"] === true
        ? undefined
        : decode(ui.SendMessageResponseSchema, result);
    },
    {
      // A lost HTTP response cannot establish whether the BFF/home committed the request.
      uncertain: (error) => !(error instanceof HttpError) || error.status >= 500,
      onWaiting,
      signal: pending?.signal,
    },
  );
}

/** The thread's default model, effort and permission mode: unset = unchanged, "" = the profile's default. */
export async function updateThread(
  threadId: string,
  change: { model?: string; effort?: string; permissionMode?: PermissionModeKey; title?: string },
): Promise<ui.Thread | undefined> {
  return decode(ui.UpdateThreadResponseSchema, await post(`${threadPath(threadId)}/settings`, change)).thread;
}

/** Shared by panel, palette and the future sidebar context menu. The title arrives on the live streams. */
export async function regenerateTitle(threadId: string): Promise<void> {
  await post(`${threadPath(threadId)}/regenerate-title`, {});
}

/** A new main thread with the history of `threadId` up to and including the ended turn `turnId` ("Fork from here"). */
export async function forkThread(threadId: string, turnId: string): Promise<ui.Thread | undefined> {
  return decode(ui.CreateThreadResponseSchema, await post(`${threadPath(threadId)}/fork`, { turnId })).thread;
}

/** Opens the thread's directory in the file manager of its worker's computer. */
export async function revealThreadDirectory(threadId: string): Promise<void> {
  await requestJson("POST", `${threadPath(threadId)}/reveal`, {}, 30_000);
}

export async function interruptThread(threadId: string): Promise<void> {
  await post(`${threadPath(threadId)}/interrupt`, {});
}

/** No drafts, retries, telemetry or diagnostic error payloads at this boundary. */
export async function answerThreadSecret(
  requestId: string,
  answer: { value?: string; decline?: boolean; revoke?: boolean },
): Promise<ui.ThreadSecret | undefined> {
  try {
    return decode(
      ui.ThreadSecretResponseSchema,
      await post(`/api/thread-secrets/${encodeURIComponent(requestId)}`, answer),
    ).secret;
  } catch {
    throw new Error("Could not update the secret. Paste it again to retry.");
  }
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

// ---------- the queue (docs/ui-api.md, "Kolejka"); a message that already started is a 409 with the reason

const queuePath = (threadId: string, turnId?: string) =>
  `${threadPath(threadId)}/queue${turnId ? `/${encodeURIComponent(turnId)}` : ""}`;

/** New order of the queued turns; returns them as the gateway stored them (new ordinals). */
export async function reorderQueue(threadId: string, turnIds: readonly string[]): Promise<ui.Turn[]> {
  return decode(ui.ReorderQueuedTurnsResponseSchema, await post(queuePath(threadId), { turnIds })).turns;
}

/**
 * A queued message's new text with all its mentions (`mentionsComplete`: the gateway takes them as the whole set);
 * `expectedRevision` = the `Turn.revision` the edit started from.
 */
export async function editQueued(
  threadId: string,
  turnId: string,
  text: string,
  expectedRevision: number,
  mentions: readonly Mention[] = [],
): Promise<ui.Turn | undefined> {
  return decode(
    ui.EditQueuedTurnResponseSchema,
    await post(queuePath(threadId, turnId), {
      action: "edit",
      text,
      expectedRevision,
      mentionsComplete: true,
      ...(mentions.length > 0 && { mentions: mentionsToWire(mentions) }),
    }),
  ).turn;
}

export async function deleteQueued(threadId: string, turnId: string): Promise<ui.Turn | undefined> {
  return decode(ui.DeleteQueuedTurnResponseSchema, await post(queuePath(threadId, turnId), { action: "delete" })).turn;
}

/** Undo of a delete: back in the queue at its place. */
export async function restoreQueued(threadId: string, turnId: string): Promise<ui.Turn | undefined> {
  return decode(ui.RestoreQueuedTurnResponseSchema, await post(queuePath(threadId, turnId), { action: "restore" }))
    .turn;
}

/** The queued message into the running turn now (it leaves the queue; back at its place if it cannot join). */
export async function steerQueued(threadId: string, turnId: string): Promise<ui.SteerQueuedTurnResponse> {
  return decode(ui.SteerQueuedTurnResponseSchema, await post(queuePath(threadId, turnId), { action: "steer" }));
}
