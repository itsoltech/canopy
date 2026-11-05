import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Adds a directory on any worker (also a linked computer's) as a project workspace; a clone may take minutes. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.AddProjectRequestSchema);

  return json(
    encode(ui.AddProjectResponseSchema, await call((api) => api.addProject(body, { timeoutMs: 6 * 60_000 + 15_000 }))),
  );
};
