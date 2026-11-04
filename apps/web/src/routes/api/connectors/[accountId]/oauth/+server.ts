import { json } from "@sveltejs/kit";
import { randomBytes } from "node:crypto";
import { connectors } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, url, cookies }) => {
  const body = await readMessage(request, connectors.BeginConnectorOAuthRequestSchema);
  const binding = cookies.get("canopy-connector-oauth") ?? randomBytes(32).toString("base64url");

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

  cookies.set("canopy-connector-oauth", binding, {
    path: "/api/connectors",
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: 600,
  });

  return json({ authorizationUrl: result.authorizationUrl }, { headers: { "Cache-Control": "no-store" } });
};
