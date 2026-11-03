import { gt, prerelease, valid } from "semver";
import type { DesktopChannel } from "./identity.ts";

export interface DesktopRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

export const channelRank = { stable: 0, beta: 1, nightly: 2 } as const;
export const channelFeed = (channel: DesktopChannel) => channel === "stable" ? "latest" : channel;
export const isDesktopChannel = (value: unknown): value is DesktopChannel => value === "stable" || value === "beta" || value === "nightly";

// Feed aliases on each release are cumulative: stable -> all, beta -> beta/nightly.
export function newestRelease(releases: readonly DesktopRelease[], current: string, channel: DesktopChannel, feedFile: string, allowDowngrade = false) {
  return releases.filter((release) => {
    const version = valid(release.tag_name);
    const pre = version ? prerelease(version) : null;
    const releaseChannel = !pre && !release.prerelease ? "stable" : release.prerelease && isDesktopChannel(pre?.[0]) && pre?.[0] !== "stable" ? pre[0] : undefined;
    return version && (allowDowngrade || gt(version, current)) && !release.draft &&
      releaseChannel !== undefined && channelRank[releaseChannel] <= channelRank[channel] &&
      release.assets.some((asset) => asset.name === feedFile) &&
      release.assets.some((asset) => asset.name === "manifest.json");
  }).sort((a, b) => gt(a.tag_name, b.tag_name) ? -1 : 1)[0];
}
