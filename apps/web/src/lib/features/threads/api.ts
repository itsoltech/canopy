import { ui } from "@open-agents/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/** Browser-side calls to the BFF (same origin, JSON). */
const post = (path: string, body: unknown) => requestJson("POST", path, body);

/** `model` / `effort`: this turn only (unset = the thread's defaults). */
export async function sendMessage(threadId: string, text: string, clientRequestId: string, turn: { model?: string; effort?: string } = {}): Promise<ui.Turn | undefined> {
  return decode(ui.SendMessageResponseSchema, await post(`/api/threads/${encodeURIComponent(threadId)}/messages`, { text, clientRequestId, ...turn })).turn;
}

/** The thread's default model and effort: unset = unchanged, "" = the profile's default. */
export async function updateThread(threadId: string, change: { model?: string; effort?: string }): Promise<ui.Thread | undefined> {
  return decode(ui.UpdateThreadResponseSchema, await post(`/api/threads/${encodeURIComponent(threadId)}/settings`, change)).thread;
}

export async function interruptThread(threadId: string): Promise<void> {
  await post(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, {});
}

export async function answerInteraction(
  requestId: string,
  answer: { allow?: boolean; allowForSession?: boolean; message?: string; answerJson?: string; cancelled?: boolean },
): Promise<void> {
  await post(`/api/interactions/${encodeURIComponent(requestId)}`, answer);
}
