export type DesktopChannel = "stable" | "beta" | "nightly";
declare const CANOPY_DESKTOP_CHANNEL: string | undefined;

export function desktopIdentity(value = (typeof CANOPY_DESKTOP_CHANNEL === "string" ? CANOPY_DESKTOP_CHANNEL : process.env["CANOPY_CHANNEL"]) ?? "stable") {
  if (value !== "stable" && value !== "beta" && value !== "nightly") throw new Error(`Invalid desktop channel: ${value}`);
  const channel: DesktopChannel = value;
  return {
    channel,
    productName: "Canopy",
    artifactPrefix: "Canopy",
    executableName: "canopy",
    appId: "app.canopy.desktop",
    scheme: "canopy",
    feed: channel === "stable" ? "latest" : channel,
  };
}
