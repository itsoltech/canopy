import { SETTINGS_CLIENTS, settingsGuide } from "@canopy/domain";
import { findCanopySettings } from "../../core/settings-guide.ts";
import { decoded, define, object, str } from "./shared.ts";

export const canopySettingsGuide = define(
  settingsGuide.name,
  settingsGuide.description,
  object({ query: str, client: { type: "string", enum: [...SETTINGS_CLIENTS] }, client_version: str }, ["query"]),
  "Looking up Canopy settings",
  async ({ args }) => findCanopySettings(decoded(settingsGuide.args, args)),
  "read",
);
