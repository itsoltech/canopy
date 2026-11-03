import { json } from "@sveltejs/kit";
import { connectors } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, connectors.SaveConnectorOAuthAppRequestSchema);
  await call((api) => api.saveConnectorOAuthApp(body));
  return json({ saved: true });
};
