import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Git refs and earlier worktrees of a workspace, for the new-thread composer. A read: POST for the protobuf body. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ListGitRefsRequestSchema);

  return json(encode(ui.ListGitRefsResponseSchema, await call((api) => api.listGitRefs(body, { timeoutMs: 25_000 }))));
};
