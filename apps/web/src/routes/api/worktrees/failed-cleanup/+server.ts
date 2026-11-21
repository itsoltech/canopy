import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.CleanUpFailedWorktreeRequestSchema);
  await call((api) => api.cleanUpFailedWorktree(body, { timeoutMs: 65_000, signal: request.signal }));

  return json({});
};
