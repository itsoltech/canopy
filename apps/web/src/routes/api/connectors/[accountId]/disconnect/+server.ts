import { json } from "@sveltejs/kit";
import { connectors } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async ({ params }) => json(encode(connectors.ConnectorAccountResponseSchema,
  await call((api) => api.disconnectConnector({ accountId: params.accountId }, { timeoutMs: 50_000 }))));
