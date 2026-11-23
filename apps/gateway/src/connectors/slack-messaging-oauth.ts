import { createHash, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { oauthRedirectUrl } from "./catalog.ts";
import { returnState } from "@canopy/domain/oauth-return";
import { SLACK_BOT_SCOPES } from "./slack-app.ts";
import type { Credentials, RegisteredApp } from "./records.ts";
import type { SlackBotAuthorization } from "../messengers/types.ts";
import type { SlackTransport } from "../messengers/slack-http.ts";

export function beginSlackMessaging(
  callback: string | undefined,
  desktop: boolean,
  app: RegisteredApp,
  setup: NonNullable<Credentials["slackMessaging"]>,
) {
  if (!app.client_secret) throw new Error("Slack app secret required");
  const redirectUri = app.redirect_uri || callback || oauthRedirectUrl();
  const nonce = randomBytes(32).toString("base64url");

  const state =
    !callback || redirectUri === callback ? nonce : returnState(nonce, desktop ? { desktop: true } : { callback });

  const verifier = randomBytes(32).toString("base64url");
  const authorization = new URL("https://slack.com/oauth/v2/authorize");
  authorization.search = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirectUri,
    scope: SLACK_BOT_SCOPES.join(","),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const value: Credentials = { client: app, redirectUri, verifier, slackMessaging: setup };

  return { authorizationUrl: authorization.href, value, state };
}

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    ok: Schema.Boolean,
    access_token: Schema.optional(Schema.String),
    refresh_token: Schema.optional(Schema.String),
    expires_in: Schema.optional(Schema.Number),
    token_type: Schema.optional(Schema.String),
    app_id: Schema.optional(Schema.String),
    team: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
);

/** Slack bot OAuth has a different endpoint/envelope from Slack MCP user OAuth. No automatic retries. */
export async function exchangeSlackBot(
  app: RegisteredApp,
  grant: { code: string; redirectUri: string; verifier: string } | { refreshToken: string },
  transport: SlackTransport = {},
): Promise<Omit<SlackBotAuthorization, "appToken">> {
  if (!app.client_secret) throw new Error("Slack app secret required");
  const body = new URLSearchParams({ client_id: app.client_id, client_secret: app.client_secret });

  if ("code" in grant) {
    body.set("code", grant.code);
    body.set("redirect_uri", grant.redirectUri);
    body.set("code_verifier", grant.verifier);
  } else {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", grant.refreshToken);
  }

  const response = await (transport.fetch ?? fetch)(
    new URL("oauth.v2.access", transport.apiBaseUrl ?? "https://slack.com/api/"),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Slack authorization failed");
  }

  const value = decode(await response.json());

  if (
    !value.ok ||
    !value.access_token ||
    !/^(xoxb-|xoxe\.xoxb-)/.test(value.access_token) ||
    (value.token_type && value.token_type !== "bot") ||
    (value.expires_in !== undefined &&
      (!Number.isFinite(value.expires_in) || value.expires_in <= 60 || !value.refresh_token))
  )
    throw new Error("Slack authorization failed");

  return {
    botToken: value.access_token,
    clientId: app.client_id,
    ...(value.refresh_token && { refreshToken: value.refresh_token }),
    ...(value.expires_in && { expiresAt: Date.now() + value.expires_in * 1000 }),
    ...(value.app_id && { appId: value.app_id }),
    ...(value.team && { teamId: value.team.id }),
  };
}
