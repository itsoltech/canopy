import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Background workspace copies of this owner; changes arrive on the overview stream. */
export const GET: RequestHandler = async () =>
  json(encode(ui.ListWorkspaceCopyJobsResponseSchema, await call((api) => api.listWorkspaceCopyJobs({}))), {
    headers: { "cache-control": "no-store" },
  });

/** Starts a copy in the background; answers once the selection is authorized and the destination prepared. */
export const POST: RequestHandler = async ({ request }) => {
  const input = await readMessage(request, ui.CopyWorkspaceRequestSchema);

  return json(
    encode(ui.WorkspaceCopyJobSchema, await call((api) => api.startWorkspaceCopy(input, { timeoutMs: 130_000 }))),
  );
};
