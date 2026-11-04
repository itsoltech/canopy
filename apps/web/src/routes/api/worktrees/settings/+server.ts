import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** One scope of the worktree settings (docs/worktrees.md). A read: POST only because the request is a protobuf message. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.GetWorktreeSettingsRequestSchema);

  return json(encode(ui.WorktreeSettingsResponseSchema, await call((api) => api.getWorktreeSettings(body))));
};

/** Replaces a scope's overrides (with the version it started from). */
export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.UpdateWorktreeSettingsRequestSchema);

  return json(encode(ui.WorktreeSettingsResponseSchema, await call((api) => api.updateWorktreeSettings(body))));
};
