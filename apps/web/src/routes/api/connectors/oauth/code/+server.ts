import { json } from "@sveltejs/kit";
import { connectors } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { connectorOAuthBinding } from "#lib/server/connector-oauth.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** The manual and desktop return: a pasted code, or the code and state from canopy://oauth/callback. */
export const POST: RequestHandler = async ({ request, cookies }) => {
  const body = await readMessage(request, connectors.CompleteConnectorOAuthRequestSchema);

  const response = await gateway().completeConnectorOAuth(
    {
      state: body.state,
      code: body.code,
      error: body.error,
      issuer: body.issuer,
      pastedCode: body.pastedCode,
      browserBinding: connectorOAuthBinding(cookies.get("canopy-connector-oauth")),
    },
    { timeoutMs: 60_000 },
  );

  return json(encode(connectors.CompleteConnectorOAuthResponseSchema, response), {
    headers: { "Cache-Control": "no-store" },
  });
};
