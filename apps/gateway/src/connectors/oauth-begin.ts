import { create } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { ConnectorFailure } from "./records.ts";
import { connectorUrl } from "./catalog.ts";
import { beginOAuth } from "./sign-in.ts";
import { OAuthStartFailure, oauthStartMessage, type OAuthStartStage } from "./oauth-error.ts";
import { beginSlackMessaging } from "./slack-messaging-oauth.ts";
import { slackRequest, type SlackTransport } from "../messengers/slack-http.ts";
import type { ConnectorsRuntime } from "./runtime.ts";

export async function beginConnectorOAuth(
  runtime: Pick<ConnectorsRuntime, "run">,
  user: string,
  request: connectors.BeginConnectorOAuthRequest,
  options: { messengerTransport?: SlackTransport; log?: (message: string) => void },
) {
  if (!/^[\w-]{32,128}$/.test(request.browserBinding) || request.scope.length > 4000)
    throw new ConnectorFailure("Invalid OAuth session");
  const redirect = connectorUrl(request.redirectUri);

  if (new URL(redirect).pathname !== "/api/connectors/oauth/callback")
    throw new ConnectorFailure("Invalid OAuth callback");
  const row = await runtime.run((s) => s.owned(user, request.accountId));

  if (request.slackMessaging && row.connector_type !== "slack") throw new ConnectorFailure("Choose a Slack connection");

  if (row.auth_kind !== "oauth") throw new ConnectorFailure("This account uses token authentication");
  const app = await runtime.run((s) => s.app(user, row.connector_type));
  const previous = await runtime.run((s) => s.credentials(row));
  let stage: OAuthStartStage = "authorization";

  try {
    if (request.slackMessaging && (!app || previous.client?.client_id !== app.client_id))
      throw new Error("Reconnect this Slack connection before enabling messages");

    if (request.slackMessaging && !previous.slackTeamId) {
      if (!previous.tokens?.access_token) throw new Error("Reconnect Slack MCP before enabling messages");

      const identity = await slackRequest(
        "auth.test",
        previous.tokens.access_token,
        new URLSearchParams(),
        undefined,
        options.messengerTransport,
      );

      if (!identity.team_id) throw new Error("Slack workspace is unavailable");
      previous.slackTeamId = identity.team_id;
    }

    const {
      authorizationUrl: url,
      value,
      state,
    } = request.slackMessaging
      ? app
        ? beginSlackMessaging(
            redirect,
            request.desktop,
            app,
            await runtime.run((s) => s.transaction(s.slackMessagingSetup(row))),
          )
        : (() => {
            throw new Error("Save the shared Slack app first");
          })()
      : await beginOAuth(row, redirect, request.desktop, previous, app, request.scope || undefined);

    if (!url || !value.verifier) throw new Error("Authorization redirect missing");
    const authorization = new URL(url);
    connectorUrl(`${authorization.origin}${authorization.pathname}`);

    // SDK discovery must advertise S256; never accept a downgraded PKCE flow.
    if (authorization.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE required");

    if (request.slackMessaging && previous.slackTeamId) value.slackTeamId = previous.slackTeamId;
    stage = "state";
    await runtime.run((s) => s.saveState(user, row, state, request.browserBinding, value));

    return create(connectors.BeginConnectorOAuthResponseSchema, { authorizationUrl: url });
  } catch (error) {
    const failure = error instanceof OAuthStartFailure ? error : new OAuthStartFailure(stage);

    const network = failure.network ? ` network ${failure.network.code}` : "";

    options.log?.(`connectors: oauth start failed stage ${failure.stage} status ${failure.status}${network}`);
    throw new ConnectorFailure(failure.network?.message ?? oauthStartMessage[failure.stage]);
  }
}
