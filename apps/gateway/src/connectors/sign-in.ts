import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes } from "node:crypto";
import { returnState } from "@canopy/domain/oauth-return";
import { oauthFetch, oauthRedirectUrl } from "./catalog.ts";
import { authorizeOAuth, oauthProvider } from "./oauth.ts";
import type { Credentials, RegisteredApp } from "./records.ts";

/** Only explicit sign-in discovers a new redirect or replaces a dynamic registration. */
export async function beginOAuth(
  url: string,
  callback: string,
  desktop: boolean,
  previous: Credentials,
  app?: RegisteredApp,
  scope?: string,
) {
  const discovery = await discoverOAuthServerInfo(url, { fetchFn: oauthFetch });
  const s256 = discovery.authorizationServerMetadata?.code_challenge_methods_supported?.includes("S256");
  // Manually registered apps keep the callback they were saved with, including older installation callbacks.
  const redirectUri = app ? app.redirect_uri || callback : s256 ? oauthRedirectUrl() : callback;

  if (redirectUri !== callback && !s256) throw new Error("Fixed OAuth redirect requires advertised S256");

  const client =
    app ??
    (previous.redirectUri === redirectUri &&
    (!previous.client?.issuer ||
      new URL(previous.client.issuer).href === new URL(discovery.authorizationServerUrl).href)
      ? previous.client
      : undefined);

  const value: Credentials = { redirectUri, ...(client && { client }) };
  const nonce = randomBytes(32).toString("base64url");
  const state = redirectUri === callback ? nonce : returnState(nonce, desktop ? { desktop: true } : { callback });

  // Apply the same issuer validation as token exchange before registration or authorization.
  await oauthProvider(value, state, () => {}).saveDiscoveryState?.(discovery);
  const authorizationUrl = await authorizeOAuth(url, value, state, scope);

  return { authorizationUrl, value, state };
}
