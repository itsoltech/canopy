import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.StartImportRequestSchema);

  // Creating projects for new directories asks the worker to check each one.
  return json(encode(ui.ImportRunSchema, await call((api) => api.startImport(body, { timeoutMs: 120_000 }))));
};
