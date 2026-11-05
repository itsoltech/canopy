import { json } from "@sveltejs/kit";
import { randomBytes } from "node:crypto";
import { connectors } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { connectorOAuthBinding } from "#lib/server/connector-oauth.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, url, cookies }) => {
  const body = await readMessage(request, connectors.BeginConnectorOAuthRequestSchema);
  const binding = connectorOAuthBinding(cookies.get("canopy-connector-oauth")) || randomBytes(32).toString("base64url");

  const result = await call((api) =>
    api.beginConnectorOAuth(
      {
        accountId: params.accountId,
        redirectUri: `${url.origin}/api/connectors/oauth/callback`,
        browserBinding: binding,
        scope: body.scope,
      },
      { timeoutMs: 60_000 },
    ),
  );

  if (!process.env["CANOPY_WEB_ORIGIN"])
    cookies.set("canopy-connector-oauth", binding, {
      path: "/api/connectors",
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      maxAge: 600,
    });

  return json({ authorizationUrl: result.authorizationUrl }, { headers: { "Cache-Control": "no-store" } });
};
