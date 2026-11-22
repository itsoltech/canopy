import type { JsonObject } from "@bufbuild/protobuf";
import { NETWORK_ACCESS_PURPOSE, type SettingsGuideArgs } from "@canopy/domain";
import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import {
  desktopSettingsSections,
  matchesSettingsSection,
  settingsSectionEnabled,
  settingsSearchWords,
  settingsSectionMethods,
  settingsSections,
} from "@canopy/ui/settings";

export function findCanopySettings(
  { query, client, client_version }: SettingsGuideArgs,
  version = CANOPY_VERSION,
): JsonObject {
  const reference = { version, channel: releaseChannel(version) };
  const clientVersion = client_version?.trim();
  const sectionQuery = settingsSearchWords(query).join(" ");
  const sectionContext = sectionQuery === "network access" ? { section_purpose: NETWORK_ACCESS_PURPOSE } : {};

  if (!client || !clientVersion)
    return {
      status: "unconfirmed",
      ...sectionContext,
      reason: "The client's platform and exact Canopy app version are required to verify a section.",
      missing: [...(!client ? ["client"] : []), ...(!clientVersion ? ["client_version"] : [])],
    };

  if (releaseChannel(clientVersion) === "development")
    return {
      status: "unconfirmed",
      ...sectionContext,
      reason: "The reported version does not identify a published client build.",
    };

  if (clientVersion !== version)
    return {
      status: "unconfirmed",
      ...sectionContext,
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

  const exact = sections.find((section) => settingsSearchWords(section.label).join(" ") === sectionQuery);

  if (exact) {
    const linked = exact.href === "/settings/computers";

    const requiresMethods =
      (client === "web" || client === "desktop") && Object.hasOwn(settingsSectionMethods, exact.href);

    const conditions = [
      ...(!settingsSectionEnabled(exact.href, []) ? ["The Threads module must be enabled."] : []),
      ...(linked ? ["The connected gateway must support linked computers."] : []),
      ...(!linked && requiresMethods ? [`The connected gateway must support ${exact.label}.`] : []),
    ];

    return {
      status: conditions.length ? "conditional_section" : "confirmed_section",
      reference,
      client,
      path: ["Settings", exact.label],
      scope: "The catalogue verifies the section label. Individual controls still need verification.",
      ...sectionContext,
      ...(conditions.length > 0 && { conditions }),
    };
  }

  return {
    status: "unconfirmed",
    reason: "The catalogue does not verify a section or control for this query.",
    search_suggestions: sectionQuery
      ? sections.flatMap((section) => (matchesSettingsSection(section, query) ? [section.label] : []))
      : [],
  };
}
