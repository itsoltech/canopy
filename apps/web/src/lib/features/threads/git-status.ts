import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { queries } from "#lib/shared/queries.svelte.ts";
import { decode } from "#lib/shared/wire.ts";

export class GitStatusReadError extends Error {}

/** Event-driven reads share in-flight work, without reusing a snapshot from before a completed turn. */
export async function threadGitStatus(threadId: string, signal?: AbortSignal) {
  return queries.read(
    `GetThreadGitStatus:${threadId}`,
    async (sharedSignal) => {
      const value = decode(
        ui.ThreadGitStatusResponseSchema,
        await requestJson("GET", `/api/threads/${encodeURIComponent(threadId)}/git`, undefined, 45_000, sharedSignal),
      );

      // A completed RPC may report a failed scan. Keep the previous successful counts in the cache.
      if (value.supported && !value.status && value.detail) throw new GitStatusReadError(value.detail);

      return value;
    },
    -1,
    signal,
  );
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
