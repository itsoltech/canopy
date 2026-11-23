import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { setTimeout as sleep } from "node:timers/promises";
import type { ui } from "@canopy/contracts";

/** Presence can arrive before the worker has finished applying its startup configuration. */
export async function readWorkspaceRefs(
  api: Pick<Client<typeof ui.GatewayService>, "listGitRefs">,
  request: ui.ListGitRefsRequest,
  signal: AbortSignal,
): Promise<ui.ListGitRefsResponse> {
  const options = { timeoutMs: 25_000, signal };

  try {
    return await api.listGitRefs(request, options);
  } catch (cause) {
    if (
      signal.aborted ||
      !(cause instanceof ConnectError) ||
      (cause.code !== Code.DeadlineExceeded && cause.code !== Code.Unavailable)
    )
      throw cause;
  }

  await sleep(1_000, undefined, { signal });

  return api.listGitRefs(request, options);
}
