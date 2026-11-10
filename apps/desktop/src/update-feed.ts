import { gt, valid } from "semver";
import { releaseCatalog, type ReleaseCatalog } from "@canopy/domain/release/catalog";
import type { DesktopChannel } from "./identity.ts";
import { channelFeed, channelReleases, newestRelease, releaseNotes } from "./update-releases.ts";

/** Windows and remote checks share one catalog; peers never create another metadata client. */
export class DesktopUpdateFeed {
  constructor(
    private readonly version: () => string,
    private readonly catalog: ReleaseCatalog = releaseCatalog,
  ) {}

  async resolve(channel: DesktopChannel, allowDowngrade: boolean, signal: AbortSignal) {
    const suffix =
      process.platform === "darwin"
        ? "-mac"
        : process.platform === "linux"
          ? `-linux${process.arch === "arm64" ? "-arm64" : ""}`
          : "";

    const feed = channelFeed(channel);
    const feedFile = `${feed}${suffix}.yml`;
    signal.throwIfAborted();
    const releases = await this.catalog.releases();
    signal.throwIfAborted();
    const current = this.version();
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
