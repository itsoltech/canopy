/** Separate Events API app: no MCP configuration, public callback or user OAuth token. */
export function slackMessengerAppManifest(): string {
  return JSON.stringify(
    {
      display_information: {
        name: "Canopy Messenger",
        description: "Talk to Canopy bots in Slack channels and direct messages.",
        background_color: "#007a55",
      },
      features: {
        bot_user: { display_name: "Canopy", always_online: false },
        app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "chat:write",
            "channels:history",
            "channels:read",
            "groups:history",
            "groups:read",
            "im:history",
            "mpim:history",
            "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: ["app_mention", "message.im", "message.mpim", "message.channels", "message.groups"],
        },
        socket_mode_enabled: true,
        org_deploy_enabled: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}

export function slackMessengerAppCreateUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(slackMessengerAppManifest())}`;
}
