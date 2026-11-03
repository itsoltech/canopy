export type DesktopChannel = "stable" | "beta" | "nightly";
declare const CANOPY_DESKTOP_CHANNEL: string | undefined;

export function desktopIdentity(value = (typeof CANOPY_DESKTOP_CHANNEL === "string" ? CANOPY_DESKTOP_CHANNEL : process.env["CANOPY_CHANNEL"]) ?? "stable") {
  if (value !== "stable" && value !== "beta" && value !== "nightly") throw new Error(`Invalid desktop channel: ${value}`);
  const channel: DesktopChannel = value;
  const label = channel === "stable" ? "" : channel === "beta" ? " Beta" : " Nightly";
  return {
    channel,
    productName: `Canopy${label}`,
    artifactPrefix: `Canopy${label.replace(" ", "-")}`,
    executableName: channel === "stable" ? "canopy" : `canopy-${channel}`,
    appId: `app.canopy.desktop${channel === "stable" ? "" : `.${channel}`}`,
    scheme: channel === "stable" ? "canopy" : `canopy-${channel}`,
    feed: channel === "stable" ? "latest" : channel,
  };
}
