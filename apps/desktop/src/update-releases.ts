import { gt, prerelease, valid } from "semver";
import type { DesktopChannel } from "./identity.ts";

export interface DesktopRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

// The built-in GitHub provider promotes beta to stable. Here each is a separate product.
export function newestRelease(releases: readonly DesktopRelease[], current: string, channel: DesktopChannel, feedFile: string) {
  return releases.filter((release) => {
    const version = valid(release.tag_name);
    const pre = version ? prerelease(version) : null;
    return version && gt(version, current) && !release.draft &&
      (channel === "stable" ? !release.prerelease && !pre : release.prerelease && pre?.[0] === channel) &&
      release.assets.some((asset) => asset.name === feedFile) &&
      release.assets.some((asset) => asset.name === "manifest.json");
  }).sort((a, b) => gt(a.tag_name, b.tag_name) ? -1 : 1)[0];
}
