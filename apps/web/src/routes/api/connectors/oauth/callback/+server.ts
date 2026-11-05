import { gateway } from "#lib/server/gateway.ts";
import { connectorOAuthBinding } from "#lib/server/connector-oauth.ts";
import { connectorOAuthResult } from "#lib/server/connector-oauth-result.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, cookies }) => {
  let connectorType: string | undefined;

  try {
    const response = await gateway().completeConnectorOAuth(
      {
        state: url.searchParams.get("state") ?? "",
        code: url.searchParams.get("code") ?? "",
        error: url.searchParams.get("error") ?? "",
        issuer: url.searchParams.get("iss") ?? "",
        browserBinding: connectorOAuthBinding(cookies.get("canopy-connector-oauth")),
      },
      { timeoutMs: 60_000 },
    );

    if (response.account && !response.error) connectorType = response.account.connectorType;
  } catch {
    /* Codes, tokens and provider errors never enter logs or the result page. */
  }

  return connectorOAuthResult(connectorType, Boolean(process.env["CANOPY_WEB_ORIGIN"]));
};
