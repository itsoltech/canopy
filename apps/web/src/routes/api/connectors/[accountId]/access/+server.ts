import { json } from "@sveltejs/kit";
import { connectors } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, connectors.SetConnectorAccessRequestSchema);
  return json(encode(connectors.ConnectorAccountResponseSchema, await call((api) => api.setConnectorAccess({ ...body, accountId: params.accountId }))));
};
