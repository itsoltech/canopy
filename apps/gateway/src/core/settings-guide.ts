import type { JsonObject } from "@bufbuild/protobuf";
import type { SettingsGuideArgs } from "@canopy/domain";
import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import {
  desktopSettingsSections,
  matchesSettingsSection,
  settingsSectionEnabled,
  settingsSearchWords,
  settingsSections,
} from "@canopy/ui/settings";

export function findCanopySettings({ query, client, client_version }: SettingsGuideArgs): JsonObject {
  const reference = { version: CANOPY_VERSION, channel: releaseChannel(CANOPY_VERSION) };
  const clientVersion = client_version?.trim();

  if (!client || !clientVersion)
    return {
      status: "unconfirmed",
      reason: "The client's platform and exact Canopy app version are required to verify a section.",
      missing: [...(!client ? ["client"] : []), ...(!clientVersion ? ["client_version"] : [])],
    };

  if (clientVersion !== CANOPY_VERSION)
    return {
      status: "unconfirmed",
      reference,
      reason: "This catalogue cannot verify a Settings path for a different client build.",
    };

  const sections =
    client === "desktop"
      ? [...settingsSections, ...desktopSettingsSections]
      : settingsSections.filter(
          // Native SettingsScreen has no Agent tools screen. The shared sidebar data alone is not proof.
          (section) => client === "web" || section.href !== "/settings/agent-tools",
        );

  const words = settingsSearchWords(query);
  const exact = sections.find((section) => settingsSearchWords(section.label).join(" ") === words.join(" "));

  if (exact)
    return {
      status: "confirmed_section",
      reference,
      client,
      path: ["Settings", exact.label],
      scope:
        "The section label is verified. Individual controls and visibility on the user's device still need verification.",
      conditions: [
        ...(!settingsSectionEnabled(exact.href, []) ? ["The Threads module must be enabled."] : []),
        ...(exact.href === "/settings/computers" ? ["The connected gateway must support linked computers."] : []),
        "A compatible gateway may be required.",
        ...(reference.channel === "development" ? ["For source builds this applies only to the same checkout."] : []),
      ],
    };

  return {
    status: "unconfirmed",
    reason: "The catalogue does not verify a section or control for this query.",
    search_suggestions: words.length
      ? sections.flatMap((section) => (matchesSettingsSection(section, query) ? [section.label] : []))
      : [],
  };
}
