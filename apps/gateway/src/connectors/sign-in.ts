import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes } from "node:crypto";
import { returnState } from "@canopy/domain/oauth-return";
import { oauthRedirectUrl } from "./catalog.ts";
import { authorizeOAuth, oauthProvider } from "./oauth.ts";
import { OAuthStartFailure } from "./oauth-error.ts";
import type { AccountRow, Credentials, RegisteredApp } from "./records.ts";

import { oauthEgress } from "./oauth-egress.ts";

/** Only explicit sign-in discovers a new redirect or replaces a dynamic registration. */
export async function beginOAuth(
  account: Pick<AccountRow, "url" | "connector_type">,
  callback: string,
  desktop: boolean,
  previous: Credentials,
  app?: RegisteredApp,
  scope?: string,
) {
  const egress = oauthEgress(account.url, app?.issuer);
  let discoveryStatus = 0;

  const discovery = await discoverOAuthServerInfo(account.url, {
    fetchFn: async (input, init) => {
      discoveryStatus = 0;
      const response = await egress.fetch(input, init);
      discoveryStatus = response.status;

      return response;
    },
  }).catch(() => {
    throw new OAuthStartFailure("discovery", discoveryStatus);
  });

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
  let registrationStatus: number | undefined;

  const authorizationUrl = await authorizeOAuth(
    account,
    {
      ...egress,
      fetch: async (input, init) => {
        if (init?.method !== "POST") return egress.fetch(input, init);
        registrationStatus = 0;
        const response = await egress.fetch(input, init);
        registrationStatus = response.status;

        return response;
      },
    },
    value,
    state,
    scope,
  ).catch(() => {
    if (registrationStatus !== undefined && !value.client)
      throw new OAuthStartFailure("registration", registrationStatus);
    throw new OAuthStartFailure("authorization");
  });

  return { authorizationUrl, value, state };
}
