import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const message = await readMessage(request, ui.CollectDiagnosticsLogsRequestSchema);

  return json(encode(ui.DiagnosticsLogsJobSchema, await call((api) => api.collectDiagnosticsLogs(message))), {
    headers: { "cache-control": "no-store" },
  });
};
