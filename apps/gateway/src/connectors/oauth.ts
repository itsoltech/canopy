import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAUTH_CLIENT_METADATA_REDIRECT_URL, OAUTH_CLIENT_METADATA_URL } from "@canopy/domain/oauth-return";
import { Predicate, Schema } from "effect";
import type { Credentials } from "./store.ts";
import { oauthEgress } from "./oauth-egress.ts";
import { OAuthNetworkFailure } from "./oauth-network.ts";
import { recordOAuthIdentity } from "./oauth-identity.ts";
import type { AccountRow, RegisteredApp } from "./records.ts";
import { httpMcpFailure, networkMcpFailure } from "../bots/mcp-errors.ts";

export function oauthAppForIssuer(type: string, app?: RegisteredApp, issuer?: string) {
  if (type === "custom" && app?.issuer && issuer && new URL(app.issuer).href !== new URL(issuer).href) return undefined;

  return app;
}

export function sessionOAuthEgress(
  account: Pick<AccountRow, "connector_type" | "url">,
  value: Credentials,
  app?: RegisteredApp,
) {
  const issuer = oauthAppForIssuer(account.connector_type, app, value.discovery?.authorizationServerUrl)?.issuer;

  return oauthEgress(account.url, issuer, { publicOrigins: value.oauthPublicOrigins });
}

/** Mutable only inside a gateway operation; the complete state is persisted encrypted. */
export function oauthProvider(value: Credentials, state: string, redirect: (url: URL) => void): OAuthClientProvider {
  return {
    redirectUrl: value.redirectUri,
    // The public metadata document permits only the shared Pages callback.
    ...(value.redirectUri === OAUTH_CLIENT_METADATA_REDIRECT_URL && { clientMetadataUrl: OAUTH_CLIENT_METADATA_URL }),
    clientMetadata: {
      client_name: "Canopy",
      redirect_uris: value.redirectUri ? [value.redirectUri] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: value.client?.client_secret ? "client_secret_post" : "none",
    },
    state: () => state,
    clientInformation: () => value.client,
    saveClientInformation: (client) => {
      value.client = client;
    },
    tokens: () => value.tokens,
    saveTokens: (tokens) => {
      value.tokens = tokens;

      if (tokens.expires_in) value.expiresAt = Date.now() + tokens.expires_in * 1000;
      else delete value.expiresAt;
    },
    redirectToAuthorization: redirect,
    saveCodeVerifier: (verifier) => {
      value.verifier = verifier;
    },
    codeVerifier: () => {
      if (!value.verifier) throw new Error("PKCE session missing");

      return value.verifier;
    },
    discoveryState: () => value.discovery,
    saveDiscoveryState: (discovery) => {
      const issuer = discovery.authorizationServerMetadata?.issuer;

      if (issuer && new URL(issuer).href !== new URL(discovery.authorizationServerUrl).href)
        throw new Error("OAuth issuer mismatch");

      if (value.client?.issuer && new URL(value.client.issuer).href !== new URL(discovery.authorizationServerUrl).href)
        throw new Error("OAuth app issuer mismatch");
      value.discovery = discovery;
    },
    // Fail closed. Reconnect is an explicit operation; never replace credentials on an implicit retry.
    invalidateCredentials: () => {
      throw new Error("Connector needs reconnect");
    },
  };
}

export async function authorizeOAuth(
  account: Pick<AccountRow, "url" | "connector_type">,
  egress: ReturnType<typeof oauthEgress>,
  value: Credentials,
  state: string,
  scope?: string,
  code?: string,
): Promise<string | undefined> {
  let authorizationUrl: string | undefined;
  let refreshFailure: OAuthNetworkFailure | undefined;

  const result = await auth(
    oauthProvider(value, state, (redirect) => {
      authorizationUrl = redirect.toString();
    }),
    {
      serverUrl: account.url,
      fetchFn: async (input, init) => {
        const exchanging = code !== undefined && init?.method === "POST";
        const signal = AbortSignal.timeout(20_000);

        const response = await egress.fetch(input, { ...init, signal }).catch((cause: unknown) => {
          if (exchanging) throw networkMcpFailure(cause, "oauth/token", signal);

          if (value.tokens?.refresh_token && init?.method === "POST" && cause instanceof OAuthNetworkFailure)
            refreshFailure = cause;
          throw cause;
        });

        // Capture the provider's reason before SDK recovery replaces invalid_client/invalid_grant.
        if (exchanging) {
          const failure = await httpMcpFailure(response.clone(), "oauth/token");

          // Slack can return an OAuth error envelope with HTTP 200.
          if (!response.ok || failure.serverCode) throw failure;
        }

        const issuer = value.discovery?.authorizationServerUrl;

        const tokenUrl = issuer
          ? new URL(value.discovery?.authorizationServerMetadata?.token_endpoint ?? "/token", issuer)
          : undefined;

        const target = new URL(input instanceof Request ? input.url : String(input));

        if (issuer && tokenUrl?.href === target.href && response.ok && init?.method === "POST") {
          const metadata = await response
            .clone()
            .json()
            .then(Schema.decodeUnknownSync(Schema.JsonObject))
            .catch(() => undefined);

          if (metadata && Predicate.isString(metadata["access_token"]))
            recordOAuthIdentity(account.connector_type, value, metadata, issuer);
        }

        return response;
      },
      ...(scope && { scope }),
      ...(code !== undefined && { authorizationCode: code }),
    },
  );

  // The SDK can fall through to a new authorization URL after a failed refresh.
  if (result !== "AUTHORIZED" && refreshFailure) throw refreshFailure;

  if (code !== undefined && result !== "AUTHORIZED") throw new Error("OAuth authorization incomplete");
  value.oauthPublicOrigins = egress.publicOrigins();

  return authorizationUrl;
}

export async function revokeOAuth(value: Credentials, egress: ReturnType<typeof oauthEgress>): Promise<boolean> {
  // RFC 7009 metadata the SDK passes through without declaring it.
  const metadata = value.discovery?.authorizationServerMetadata;
  const revocation = Predicate.hasProperty(metadata, "revocation_endpoint") ? metadata.revocation_endpoint : undefined;
  const endpoint = Predicate.isString(revocation) ? revocation : undefined;

  if (!endpoint || !value.client || !value.tokens) return false;
  let success = true;

  for (const [token, hint] of [
    [value.tokens.refresh_token, "refresh_token"],
    [value.tokens.access_token, "access_token"],
  ]) {
    if (!token) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint!, client_id: value.client.client_id });
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
    const methods = value.discovery?.authorizationServerMetadata?.token_endpoint_auth_methods_supported ?? [];

    if (value.client.client_secret) {
      if (methods.includes("client_secret_basic"))
        headers.set(
          "Authorization",
          `Basic ${Buffer.from(`${encodeURIComponent(value.client.client_id)}:${encodeURIComponent(value.client.client_secret)}`).toString("base64")}`,
        );
      else body.set("client_secret", value.client.client_secret);
    }

    try {
      success = (await egress.fetch(endpoint, { method: "POST", headers, body })).ok && success;
    } catch {
      success = false;
    }
  }

  return success;
}

/** Defense against credential echo in tool/catalog/error responses, before storage or the worker link. */
export function redactConnector(text: string, value: Credentials, additional: readonly string[] = []): string {
  const secrets = [
    ...additional,
    ...Object.values(value.headers ?? {}),
    value.tokens?.access_token,
    value.tokens?.refresh_token,
    value.client?.client_secret,
    value.verifier,
  ].filter((v): v is string => !!v);

  const variants = [
    ...new Set(
      secrets.flatMap((s) => [s, s.replace(/^Bearer\s+/i, ""), JSON.stringify(s).slice(1, -1), encodeURIComponent(s)]),
    ),
  ].sort((a, b) => b.length - a.length);

  for (const secret of variants) if (secret) text = text.replaceAll(secret, "[REDACTED]");

  return text;
}
