import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export async function continueThreadInWorktree(threadId: string, baseRef: string, clientRequestId: string) {
  const response = decode(
    ui.CreateThreadResponseSchema,
    await requestJson(
      "POST",
      `/api/threads/${encodeURIComponent(threadId)}/continue-worktree`,
      { baseRef, clientRequestId },
      135_000,
    ),
  );

  if (!response.thread) throw new Error("Could not create the worktree. Try again.");

  return response.thread;
}
