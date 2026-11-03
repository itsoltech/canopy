import { json } from "@sveltejs/kit";
import { connectors } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async ({ params }) => json(encode(connectors.TestConnectorResponseSchema,
  await call((api) => api.testConnector({ accountId: params.accountId }, { timeoutMs: 30_000 }))));
