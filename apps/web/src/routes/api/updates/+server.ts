import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const response = (value: ui.UpdatesSnapshot) => json(encode(ui.UpdatesSnapshotSchema, value), { headers: { "cache-control": "no-store" } });
export const GET: RequestHandler = async () => response(await call((api) => api.getUpdates({})));
export const POST: RequestHandler = async ({ request }) => {
  const message = await readMessage(request, ui.ManageUpdatesRequestSchema);
  return response(await call((api) => api.manageUpdates(message, { timeoutMs: 150_000 })));
};
