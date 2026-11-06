import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ContinueImportedThreadRequestSchema);

  return json(
    encode(ui.GetThreadResponseSchema, await call((api) => api.continueImportedThread(body, { timeoutMs: 60_000 }))),
  );
};
