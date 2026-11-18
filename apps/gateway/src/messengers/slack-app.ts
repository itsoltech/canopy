import { oauthRedirectUrl } from "../connectors/catalog.ts";
import { slackAppManifest } from "../connectors/slack-app.ts";

/** Legacy messenger catalog fields expose the same app used by Settings → Connectors. */
export function slackMessengerAppManifest(): string {
  return slackAppManifest(oauthRedirectUrl()).manifest;
}

export function slackMessengerAppCreateUrl(): string {
  return slackAppManifest(oauthRedirectUrl()).createUrl;
}
