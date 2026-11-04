import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.RemoveWorktreeRequestSchema);
  await call((api) => api.revealWorktree(body, { timeoutMs: 25_000 }));

  return json({});
};
