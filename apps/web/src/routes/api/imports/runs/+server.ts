import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
  json(encode(ui.ListImportRunsResponseSchema, await call((api) => api.listImportRuns({}))));

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.GetImportRunRequestSchema);

  return json(encode(ui.ImportRunSchema, await call((api) => api.getImportRun(body))));
};
