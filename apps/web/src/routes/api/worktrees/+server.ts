import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ListWorktreesRequestSchema);

  return json(
    encode(ui.ListWorktreesResponseSchema, await call((api) => api.listWorktrees(body, { timeoutMs: 120_000 }))),
  );
};

export const DELETE: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.RemoveWorktreeRequestSchema);

  return json(encode(ui.WorktreeEntrySchema, await call((api) => api.removeWorktree(body, { timeoutMs: 125_000 }))));
};
