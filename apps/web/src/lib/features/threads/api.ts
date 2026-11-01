import { ui } from "@open-agents/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/** Browser-side calls to the BFF (same origin, JSON). */
const post = (path: string, body: unknown) => requestJson("POST", path, body);

export async function sendMessage(threadId: string, text: string, clientRequestId: string): Promise<ui.Turn | undefined> {
  return decode(ui.SendMessageResponseSchema, await post(`/api/threads/${encodeURIComponent(threadId)}/messages`, { text, clientRequestId })).turn;
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
