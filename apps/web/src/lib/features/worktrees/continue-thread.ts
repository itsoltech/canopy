import { ui } from "@canopy/contracts";
import { WORKTREE_CLIENT_TIMEOUT_MS } from "@canopy/domain/worktree-timing";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export async function continueThreadInWorktree(threadId: string, baseRef: string, clientRequestId: string) {
  const response = decode(
    ui.CreateThreadResponseSchema,
    await requestJson(
      "POST",
      `/api/threads/${encodeURIComponent(threadId)}/continue-worktree`,
      { baseRef, clientRequestId },
      WORKTREE_CLIENT_TIMEOUT_MS + 10_000,
    ),
  );

  if (!response.thread) throw new Error("Could not create the worktree. Try again.");

  return response.thread;
}
