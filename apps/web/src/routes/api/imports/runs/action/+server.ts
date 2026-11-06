import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Cancel, resume or undo an import run: `?action=cancel|resume|undo`. */
export const POST: RequestHandler = async ({ request, url }) => {
  const body = await readMessage(request, ui.ImportRunRequestSchema);

  switch (url.searchParams.get("action")) {
    case "cancel":
      return json(encode(ui.ImportRunSchema, await call((api) => api.cancelImportRun(body))));
    case "resume":
      return json(encode(ui.ImportRunSchema, await call((api) => api.resumeImportRun(body))));
    case "undo":
      return json(encode(ui.ImportRunSchema, await call((api) => api.undoImportRun(body, { timeoutMs: 120_000 }))));
    default:
      error(400, "Unknown action");
  }
};
