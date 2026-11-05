/**
 * The Slack app a workspace creates for Canopy: Slack has no dynamic client registration. Every installation
 * uses the same fixed redirect URL, so the manifest is the same and colleagues can share one app.
 * Checked against Slack's documentation, 2026-11-05:
 * https://docs.slack.dev/ai/slack-mcp-server/ (user scopes per MCP tool; only internal or Marketplace apps
 * may use MCP), https://docs.slack.dev/reference/app-manifest and
 * https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/ (prefilled creation link).
 */
export const SLACK_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "files:read",
  "files:write",
  "emoji:read",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "channels:read",
  "groups:read",
  "mpim:read",
  "im:read",
  "channels:write",
  "groups:write",
  "mpim:write",
  "im:write",
  "reactions:read",
  "reactions:write",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "lists:read",
  "lists:write",
] as const;

/**
 * Manifest for "create app from manifest", with no secrets. No public distribution: Slack blocks MCP for
 * unlisted apps. Token rotation stays off: Slack cannot turn it off again, and plain tokens do not expire.
 */
export function slackAppManifest(redirectUrl: string) {
  const manifest = {
    display_information: {
      name: "Canopy",
      description: "Canopy agents read and send Slack messages for you. Made by IT SOL.",
      // Emerald 700 from the Canopy palette (packages/ui/src/palette.json, the Grove accent).
      background_color: "#007a55",
    },
    oauth_config: { redirect_urls: [redirectUrl], scopes: { user: [...SLACK_USER_SCOPES] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };

  return {
    manifest: JSON.stringify(manifest, null, 2),
    createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
  };
}
