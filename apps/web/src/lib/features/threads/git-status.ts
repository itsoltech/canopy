import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { queries } from "#lib/shared/queries.svelte.ts";
import { decode } from "#lib/shared/wire.ts";

/** Event-driven reads share in-flight work, without reusing a snapshot from before a completed turn. */
export async function threadGitStatus(threadId: string, signal?: AbortSignal) {
  const value = await queries.read(
    `GetThreadGitStatus:${threadId}`,
    async (sharedSignal) =>
      decode(
        ui.ThreadGitStatusResponseSchema,
        await requestJson("GET", `/api/threads/${encodeURIComponent(threadId)}/git`, undefined, 40_000, sharedSignal),
      ),
    -1,
  );

  signal?.throwIfAborted();

  return value;
}

export async function pullThreadOrigin(threadId: string) {
  const value = decode(
    ui.ThreadGitStatusResponseSchema,
    await requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/git`, undefined, 135_000),
  );

  queries.set(`GetThreadGitStatus:${threadId}`, value);

  return value;
}

/** Client feedback; the gateway and worker independently enforce checkout admission. */
export function pullBusyReason(thread: ui.Thread): string {
  if (thread.archivedAt || thread.deletedAt) return "Open an active thread to pull changes.";

  if (thread.goalStatus && !["achieved", "cancelled"].includes(thread.goalStatus))
    return "Clear the thread’s goal before pulling changes.";

  if (
    thread.turnStarting ||
    ["creating", "running", "waiting_input"].includes(thread.status) ||
    thread.pendingInteractions ||
    thread.backgroundTasks
  )
    return "Wait for the turn and background tasks to finish before pulling.";

  return "";
}
