export type ReleaseChannel = "stable" | "beta" | "nightly";

export interface ReleaseIdentity {
  readonly channel: ReleaseChannel;
  readonly displayName: string;
  readonly assets: string;
  readonly background: string;
}

export function releaseIdentity(channel: string): ReleaseIdentity {
  if (channel !== "stable" && channel !== "beta" && channel !== "nightly")
    throw new Error(`Invalid release channel: ${channel}`);

  return {
    channel,
    displayName: channel === "stable" ? "Canopy" : `Canopy (${channel === "beta" ? "Beta" : "Nightly"})`,
    assets: `/channels/${channel}`,
    background: { nightly: "#101b38", beta: "#f6bc86", stable: "#ffffff" }[channel],
  };
}
