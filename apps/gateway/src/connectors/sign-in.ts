import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_OAUTH_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_REDIRECT_URL,
  returnState,
} from "@canopy/domain/oauth-return";
import { oauthRedirectUrl } from "./catalog.ts";
import { authorizeOAuth, oauthProvider } from "./oauth.ts";
import { OAuthStartFailure } from "./oauth-error.ts";
import type { AccountRow, Credentials, RegisteredApp } from "./records.ts";

import { OAuthEndpointRedirect, oauthEgress } from "./oauth-egress.ts";
import { OAuthNetworkFailure } from "./oauth-network.ts";

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
  let discovery: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;

  try {
    discovery = await discoverOAuthServerInfo(account.url, {
      fetchFn: async (input, init) => {
        discoveryStatus = 0;
        const response = await egress.fetch(input, init);
        discoveryStatus = response.status;

        return response;
      },
    });
  } catch (error) {
    throw new OAuthStartFailure(
      "discovery",
      error instanceof OAuthEndpointRedirect ? error.status : discoveryStatus,
      error instanceof OAuthNetworkFailure ? error : undefined,
    );
  }

  const metadata = discovery.authorizationServerMetadata;
  const s256 = metadata?.code_challenge_methods_supported?.includes("S256");
  const defaultRedirect = s256 ? oauthRedirectUrl() : callback;

  const previousClient =
    !previous.client?.issuer || new URL(previous.client.issuer).href === new URL(discovery.authorizationServerUrl).href
      ? previous.client
      : undefined;

  const useClientMetadata =
    defaultRedirect === DEFAULT_OAUTH_REDIRECT_URL &&
    metadata?.client_id_metadata_document_supported === true &&
    !(previousClient && previous.redirectUri === defaultRedirect);

  // Manually registered apps keep the callback they were saved with, including older installation callbacks.
  const redirectUri = app
    ? app.redirect_uri || callback
    : useClientMetadata
      ? OAUTH_CLIENT_METADATA_REDIRECT_URL
      : defaultRedirect;

  if (redirectUri !== callback && !s256) throw new OAuthStartFailure("discovery", discoveryStatus);

  const client = app ?? (previous.redirectUri === redirectUri ? previousClient : undefined);

  const value: Credentials = { redirectUri, ...(client && { client }) };
  const nonce = randomBytes(32).toString("base64url");

  const state =
    redirectUri === callback || (redirectUri === OAUTH_CLIENT_METADATA_REDIRECT_URL && !desktop)
      ? nonce
      : returnState(nonce, desktop ? { desktop: true } : { callback });

  try {
    // Apply the same issuer validation as token exchange before registration or authorization.
    await oauthProvider(value, state, () => {}).saveDiscoveryState?.(discovery);
  } catch {
    throw new OAuthStartFailure("discovery", discoveryStatus);
  }

  const missingRegistration = metadata && !metadata.registration_endpoint;
  let registrationStatus: number | undefined;

  try {
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
    );

    return { authorizationUrl, value, state };
  } catch (error) {
    if (!value.client && (registrationStatus !== undefined || missingRegistration))
      throw new OAuthStartFailure(
        "registration",
        error instanceof OAuthEndpointRedirect ? error.status : registrationStatus,
        error instanceof OAuthNetworkFailure ? error : undefined,
      );
    throw new OAuthStartFailure("authorization", 0, error instanceof OAuthNetworkFailure ? error : undefined);
  }
}
