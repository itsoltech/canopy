import { Schema } from "effect";

export const SETTINGS_GUIDE_TOOL = "find_canopy_settings";
export const SETTINGS_CLIENTS = ["web", "desktop", "ios", "android"] as const;

export const SETTINGS_REPLY_GUIDANCE =
  "For questions about where to change a Canopy setting, verify the path for the user's client and app version with find_canopy_settings when available. Use confirmed UI labels only. If the client, version, section, or control cannot be verified, say what you could not confirm and ask only for missing details or suggest using the app's Settings search. Never guess a tab, control, or link.";

const version = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(80));

export const settingsGuide = {
  name: SETTINGS_GUIDE_TOOL,
  description:
    "Look up Canopy Settings navigation from the app's section catalogue. Use the client and exact app version the user reported. The gateway or worker version and selected update channel do not identify the app on their device. A confirmed section verifies the section label only. Keyword hits are search suggestions, never verified locations for a specific control.",
  args: Schema.Struct({
    query: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(160)),
    client: Schema.optionalKey(Schema.Literals(SETTINGS_CLIENTS)),
    client_version: Schema.optionalKey(version),
  }),
  mutates: false,
};

export type SettingsGuideArgs = Schema.Schema.Type<typeof settingsGuide.args>;
