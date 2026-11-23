export type ReleaseChannel = "stable" | "beta" | "nightly";

export type AppChannel = ReleaseChannel | "development";

export interface AppIdentity<Channel extends AppChannel = AppChannel> {
  readonly channel: Channel;
  readonly displayName: string;
  readonly assets: string;
  readonly background: string;
}

export type ReleaseIdentity = AppIdentity<ReleaseChannel>;

export function releaseIdentity(channel: string): ReleaseIdentity {
  if (channel !== "stable" && channel !== "beta" && channel !== "nightly")
    throw new Error(`Invalid release channel: ${channel}`);

  return {
    channel,
    displayName: channel === "stable" ? "Canopy" : `Canopy (${channel === "beta" ? "Beta" : "Nightly"})`,
    assets: `/channels/${channel}`,
    background: { nightly: "#35294F", beta: "#F5C56E", stable: "#EDF0E4" }[channel],
  };
}

/** Source builds have their own artwork and use the regular application name. */
export function appIdentity(channel: string): AppIdentity {
  if (channel === "development")
    return { channel, displayName: "Canopy", assets: "/channels/development", background: "#205394" };

  return releaseIdentity(channel);
}
