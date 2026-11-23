import { appIdentity, type ReleaseChannel } from "@canopy/domain/release/identity";
import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import { join } from "node:path";

export type DesktopChannel = ReleaseChannel;

/** Installation and data identity must survive both upgrades and channel switches. */
export function desktopUserData(appData: string) {
  return join(appData, "Canopy");
}

declare const CANOPY_DESKTOP_CHANNEL: string | undefined;

export function desktopIdentity(
  value = typeof CANOPY_DESKTOP_CHANNEL === "undefined"
    ? process.env["CANOPY_CHANNEL"] || releaseChannel(CANOPY_VERSION)
    : CANOPY_DESKTOP_CHANNEL,
) {
  const identity = appIdentity(value);
  const updateChannel = identity.channel === "development" ? "stable" : identity.channel;

  return {
    ...identity,
    updateChannel,
    productName: "Canopy",
    artifactPrefix: "Canopy",
    executableName: "canopy",
    appId: "app.canopy.desktop",
    scheme: "canopy",
    feed: updateChannel === "stable" ? "latest" : updateChannel,
  };
}
