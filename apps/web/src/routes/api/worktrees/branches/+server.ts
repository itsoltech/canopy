import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.WorkspaceBranchesRequestSchema);

  return json(
    encode(ui.ListGitRefsResponseSchema, await call((api) => api.listWorkspaceBranches(body, { timeoutMs: 35_000 }))),
  );
};

export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SwitchWorkspaceBranchRequestSchema);

  return json(
    encode(
      ui.SwitchWorkspaceBranchResponseSchema,
      await call((api) => api.switchWorkspaceBranch(body, { timeoutMs: 130_000 })),
    ),
  );
};
