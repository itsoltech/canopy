import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessengerMessage } from "#lib/server/messenger-body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
  json(encode(ui.ListMessengerAccountsResponseSchema, await call((api) => api.listMessengerAccounts({}))), {
    headers: { "cache-control": "no-store" },
  });

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessengerMessage(request, ui.SaveMessengerAccountRequestSchema);

  return json(encode(ui.SaveMessengerAccountResponseSchema, await call((api) => api.saveMessengerAccount(body))), {
    headers: { "cache-control": "no-store" },
  });
};
