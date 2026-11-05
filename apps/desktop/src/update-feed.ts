import { app } from "electron";
import { gt, valid } from "semver";
import type { DesktopChannel } from "./identity.ts";
import {
  channelFeed,
  channelReleases,
  isDesktopRelease,
  newestRelease,
  releaseNotes,
  type DesktopRelease,
} from "./update-releases.ts";

/** Public GitHub metadata stays in main; windows share a short cache, including incomplete publications. */
export class DesktopUpdateFeed {
  private cached?: { at: number; releases: DesktopRelease[] };

  private async releases() {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.releases;
    const releases: DesktopRelease[] = [];

    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`https://api.github.com/repos/itsoltech/canopy/releases?per_page=100&page=${page}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `canopy/${app.getVersion()}` },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) throw new Error("Release feed unavailable");
      const batch: unknown = await response.json();

      if (!Array.isArray(batch) || !batch.every(isDesktopRelease)) throw new Error("Invalid release feed");
      releases.push(...batch);

      if (batch.length < 100) {
        this.cached = { at: Date.now(), releases };

        return releases;
      }
    }

    throw new Error("Release history is too large to load completely");
  }

  async resolve(channel: DesktopChannel, allowDowngrade: boolean) {
    const suffix =
      process.platform === "darwin"
        ? "-mac"
        : process.platform === "linux"
          ? `-linux${process.arch === "arm64" ? "-arm64" : ""}`
          : "";

    const feed = channelFeed(channel);
    const feedFile = `${feed}${suffix}.yml`;
    const releases = await this.releases();
    const current = app.getVersion();
    const release = newestRelease(releases, current, channel, feedFile, allowDowngrade);
    const latest = channelReleases(releases, channel)[0];
    const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

    const publishing =
      latest && gt(latest.tag_name, current) && latest.tag_name !== release?.tag_name
        ? `${valid(latest.tag_name)} is not ready for ${platform} yet. Check again in a few minutes.`
        : undefined;

    return {
      release,
      feed,
      publishing,
      releases: release ? releaseNotes(releases, current, release.tag_name, channel) : [],
    };
  }
}
