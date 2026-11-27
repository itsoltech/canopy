/**
 * The Slack app a workspace creates for Canopy: Slack has no dynamic client registration. Every installation
 * uses the same fixed redirect URL, so the manifest is the same and colleagues can share one app.
 * Checked against Slack's documentation, 2026-11-18:
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

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "mpim:history",
  "users:read",
] as const;

const slackBotFeatures = {
  bot_user: { display_name: "Canopy", always_online: false },
  app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
};

const slackBotSettings = {
  org_deploy_enabled: false,
  socket_mode_enabled: true,
};

const slackBotEvents = {
  bot_events: ["app_mention", "message.im", "message.mpim", "message.channels", "message.groups"],
};

/** One app supplies MCP user authorization and the bot authorization used for Socket Mode. */
export function slackAppManifest(redirectUrl: string) {
  return manifestWithCreateUrl("Canopy agents read and send Slack messages for you. Made by IT SOL.", {
    oauth_config: {
      redirect_urls: [redirectUrl],
      scopes: { user: [...SLACK_USER_SCOPES], bot: [...SLACK_BOT_SCOPES] },
      pkce_enabled: true,
    },
    settings: {
      is_mcp_enabled: true,
      ...slackBotSettings,
      token_rotation_enabled: true,
      app_level_token_rotation_enabled: false,
      event_subscriptions: slackBotEvents,
    },
  });
}

export function slackBotAppManifest() {
  return manifestWithCreateUrl("Canopy bots send and receive Slack messages. Made by IT SOL.", {
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: { ...slackBotSettings, event_subscriptions: slackBotEvents },
  });
}

function manifestWithCreateUrl(description: string, options: { oauth_config: object; settings: object }) {
  const manifest = {
    display_information: {
      name: "Canopy",
      description,
      // Emerald 700 from the Canopy palette (packages/ui/src/palette.json, the Grove accent).
      background_color: "#007a55",
    },
    features: slackBotFeatures,
    ...options,
  };

  return {
    manifest: JSON.stringify(manifest, null, 2),
    createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
  };
}
