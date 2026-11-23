import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import { readWorkspaceRefs } from "#lib/features/worktrees/server/workspace-refs.ts";
import type { RequestHandler } from "./$types";

/** Git refs and earlier worktrees of a workspace, for the new-thread composer. A read: POST for the protobuf body. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ListGitRefsRequestSchema);

  return json(encode(ui.ListGitRefsResponseSchema, await call((api) => readWorkspaceRefs(api, body, request.signal))));
};
