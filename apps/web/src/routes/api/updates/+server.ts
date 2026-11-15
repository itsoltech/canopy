import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const response = (value: ui.UpdatesSnapshot) =>
  json(encode(ui.UpdatesSnapshotSchema, value), { headers: { "cache-control": "no-store" } });

export const GET: RequestHandler = async () =>
  response(
    await call((api) => bffSession().reads.read("GetUpdates", ui.UpdatesSnapshotSchema, () => api.getUpdates({}))),
  );

export const POST: RequestHandler = async ({ request }) => {
  const message = await readMessage(request, ui.ManageUpdatesRequestSchema);

  const value = await call(async (api) => {
    const session = bffSession();
    const updates = await api.manageUpdates(message, { timeoutMs: 150_000 });
    session.reads.invalidate("GetUpdates");

    return updates;
  });

  return response(value);
};
