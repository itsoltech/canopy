import { json } from "@sveltejs/kit";
import { connectors } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => json(encode(connectors.ListConnectorsResponseSchema,
  await call((api) => api.listConnectors({ threadId: url.searchParams.get("threadId") ?? "", botId: url.searchParams.get("botId") ?? "" }))), { headers: { "Cache-Control": "no-store" } });
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, connectors.SaveConnectorAccountRequestSchema);
  return json(encode(connectors.ConnectorAccountResponseSchema, await call((api) => api.saveConnectorAccount(body, { timeoutMs: 30_000 }))));
};
