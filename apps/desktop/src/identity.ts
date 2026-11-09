import { releaseIdentity, type ReleaseChannel } from "@canopy/domain/release/identity";
import { join } from "node:path";

export type DesktopChannel = ReleaseChannel;

/** Installation and data identity must survive both upgrades and channel switches. */
export function desktopUserData(appData: string) {
  return join(appData, "Canopy");
}

declare const CANOPY_DESKTOP_CHANNEL: string | undefined;

function isDefinedChannel(value: string | undefined): value is string {
  return typeof value === "string";
}

export function desktopIdentity(
  value = (typeof CANOPY_DESKTOP_CHANNEL !== "undefined" && isDefinedChannel(CANOPY_DESKTOP_CHANNEL)
    ? CANOPY_DESKTOP_CHANNEL
    : process.env["CANOPY_CHANNEL"]) ?? "stable",
) {
  if (value !== "stable" && value !== "beta" && value !== "nightly")
    throw new Error(`Invalid desktop channel: ${value}`);
  const channel: DesktopChannel = value;

  return {
    ...releaseIdentity(channel),
    channel,
    productName: "Canopy",
    artifactPrefix: "Canopy",
    executableName: "canopy",
    appId: "app.canopy.desktop",
    scheme: "canopy",
    feed: channel === "stable" ? "latest" : channel,
  };
}
