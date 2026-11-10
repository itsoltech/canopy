import { gt, prerelease, valid } from "semver";
import type { DesktopReleaseNote } from "@canopy/ui/desktop";
import type { DesktopChannel } from "./identity.ts";

export interface DesktopRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: readonly { name: string }[];
  body?: string | null;
}

function isReleaseAsset(value: unknown): value is DesktopRelease["assets"][number] {
  return !!value && typeof value === "object" && "name" in value && typeof value.name === "string";
}

export function isDesktopRelease(value: unknown): value is DesktopRelease {
  return (
    !!value &&
    typeof value === "object" &&
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    "draft" in value &&
    typeof value.draft === "boolean" &&
    "prerelease" in value &&
    typeof value.prerelease === "boolean" &&
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(isReleaseAsset) &&
    (!("body" in value) || value.body === null || typeof value.body === "string")
  );
}

export const channelRank = { stable: 0, beta: 1, nightly: 2 } as const;
export const channelFeed = (channel: DesktopChannel) => (channel === "stable" ? "latest" : channel);

export const isDesktopChannel = (value: unknown): value is DesktopChannel =>
  value === "stable" || value === "beta" || value === "nightly";

export function channelReleases(releases: readonly DesktopRelease[], channel: DesktopChannel) {
  return releases
    .filter((release) => {
      const version = valid(release.tag_name);

      if (!version || release.draft) return false;
      const pre = prerelease(version);

      const candidate =
        !pre && !release.prerelease ? "stable" : release.prerelease && pre?.[0] !== "stable" ? pre?.[0] : undefined;

      return isDesktopChannel(candidate) && channelRank[candidate] <= channelRank[channel];
    })
    .sort((a, b) => (gt(a.tag_name, b.tag_name) ? -1 : 1));
}

export function releaseNotes(
  releases: readonly DesktopRelease[],
  current: string,
  target: string,
  channel: DesktopChannel,
): DesktopReleaseNote[] {
  return channelReleases(releases, channel).flatMap((release) =>
    gt(release.tag_name, current) && !gt(release.tag_name, target) && release.body?.trim()
      ? [
          {
            version: valid(release.tag_name)!,
            markdown: release.body,
          },
        ]
      : [],
  );
}

// Feed aliases on each release are cumulative: stable -> all, beta -> beta/nightly.
export function newestRelease(
  releases: readonly DesktopRelease[],
  current: string,
  channel: DesktopChannel,
  feedFile: string,
  allowDowngrade = false,
) {
  return releases
    .filter((release) => {
      const version = valid(release.tag_name);
      const pre = version ? prerelease(version) : null;

      const releaseChannel =
        !pre && !release.prerelease
          ? "stable"
          : release.prerelease && isDesktopChannel(pre?.[0]) && pre?.[0] !== "stable"
            ? pre[0]
            : undefined;

      return (
        version &&
        (allowDowngrade || gt(version, current)) &&
        !release.draft &&
        releaseChannel !== undefined &&
        channelRank[releaseChannel] <= channelRank[channel] &&
        release.assets.some((asset) => asset.name === feedFile) &&
        release.assets.some((asset) => asset.name === "manifest.json")
      );
    })
    .sort((a, b) => (gt(a.tag_name, b.tag_name) ? -1 : 1))[0];
}
