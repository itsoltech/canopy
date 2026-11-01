import { ui } from "@open-agents/contracts";
import { decode } from "#lib/shared/wire.ts";

/** Browser-side calls to the BFF (same origin, JSON). */
async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (payload as { message?: unknown } | null)?.message;
    throw new Error(typeof message === "string" ? message : `Request failed (${response.status})`);
  }
  return payload;
}

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

/** All threads of a project (main and side), for the thread tree. */
export async function listProjectThreads(projectId: string): Promise<ui.Thread[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/threads`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Could not load the project's threads (${response.status})`);
  return decode(ui.ListThreadsResponseSchema, await response.json()).threads;
}
