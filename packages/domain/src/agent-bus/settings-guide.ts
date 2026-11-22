import { Schema } from "effect";

export const SETTINGS_GUIDE_TOOL = "find_canopy_settings";
export const SETTINGS_CLIENTS = ["web", "desktop", "ios", "android"] as const;

export const NETWORK_ACCESS_PURPOSE =
  "Canopy's Network access section manages incoming connections to Canopy, such as those from phones, other computers or workers, depending on the gateway. It has no effect on outbound internet access from an agent process, including access to GitHub.";

export const SETTINGS_REPLY_GUIDANCE = [
  "For questions about where to change a Canopy setting, use find_canopy_settings when available. Use only the client and exact app version reported by the user or supplied as verified context for this message. Windows alone does not distinguish desktop from web. A gateway version, worker version or selected update channel does not identify the user's app.",
  "Verify the section's purpose before recommending it. Section evidence verifies a label, not whether it controls the behavior the user asks about. Describe conditional sections with their visibility requirements.",
  "If the client, version, section, or control cannot be verified, explicitly say which detail is unknown and leave the path unconfirmed. Ask only for details needed to answer the question. Suggest Settings search only when relevant. Never guess a tab, control, or link.",
  NETWORK_ACCESS_PURPOSE,
].join(" ");

const version = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(80));

export const settingsGuide = {
  name: SETTINGS_GUIDE_TOOL,
  description:
    "Look up Canopy Settings navigation from the app's section catalogue. Pass only verified client and exact app version details for the user's app. The gateway or worker version and selected update channel do not identify that app. A confirmed section verifies the section label only. Use the section purpose, when provided, to check whether it applies to the question. A conditional section is visible only when its listed requirements are met. Keyword hits are search suggestions, never verified locations for a specific control.",
  args: Schema.Struct({
    query: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(160)),
    client: Schema.optionalKey(Schema.Literals(SETTINGS_CLIENTS)),
    client_version: Schema.optionalKey(version),
  }),
  mutates: false,
};

export type SettingsGuideArgs = Schema.Schema.Type<typeof settingsGuide.args>;
