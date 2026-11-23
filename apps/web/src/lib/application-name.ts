import { browser } from "$app/env";
import { appIdentity } from "@canopy/domain/release/identity";
import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";

/** The server resolves this from the running gateway before the SPA starts. */
export const applicationName = browser ? (document.documentElement.dataset["applicationName"] ?? "Canopy") : "Canopy";

const assets =
  (browser && document.documentElement.dataset["channelAssets"]) || appIdentity(releaseChannel(CANOPY_VERSION)).assets;

export const applicationIcon = (browser && window.canopyDesktop?.startupIcon) || `${assets}/icon-192.png`;
