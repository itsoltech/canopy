import { gt, valid } from "semver";
import { releaseCatalog, type ReleaseCatalog } from "@canopy/domain/release/catalog";
import { releaseChannel } from "@canopy/domain/release/version";
import type { DesktopChannel } from "./identity.ts";
import { channelFeed, channelReleases, hasDesktopFeed, releaseNotes, type DesktopRelease } from "./update-releases.ts";

/** Windows and remote checks share one catalog; peers never create another metadata client. */
export class DesktopUpdateFeed {
  constructor(
    private readonly version: () => string,
    private readonly catalog: ReleaseCatalog = releaseCatalog,
    private readonly revision?: string,
  ) {}

  async resolve(channel: DesktopChannel, signal: AbortSignal, refresh = false) {
    const suffix =
      process.platform === "darwin"
        ? "-mac"
        : process.platform === "linux"
          ? `-linux${process.arch === "arm64" ? "-arm64" : ""}`
          : "";

    const feed = channelFeed(channel);
    const feedFile = `${feed}${suffix}.yml`;
    signal.throwIfAborted();
    const releases = await this.catalog.releases(refresh);
    signal.throwIfAborted();
    const current = this.version();

    const candidates = channelReleases(releases, channel).filter(
      (release) =>
        gt(release.tag_name, current) ||
        (channel === "beta" && releaseChannel(current) === "nightly" && release.prerelease),
    );

    const compared = new Set<boolean>();
    const base = this.revision || `v${current}`;
    let release: DesktopRelease | undefined;

    for (const candidate of candidates) {
      if (compared.has(candidate.prerelease) || !hasDesktopFeed(candidate, feedFile)) continue;
      compared.add(candidate.prerelease);
      const forward = await this.catalog.isForward(base, candidate.tag_name);
      signal.throwIfAborted();

      if (forward) {
        release = candidate;
        break;
      }
    }

    const latest = candidates[0];
    const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

    const publishing =
      latest && !hasDesktopFeed(latest, feedFile)
        ? `${valid(latest.tag_name)} is not ready for ${platform} yet. Check again in a few minutes.`
        : !release && compared.size
          ? "Waiting for an update that includes this build"
          : undefined;

    return {
      release,
      feed,
      publishing,
      releases: release ? releaseNotes(releases, current, release.tag_name, channel) : [],
    };
  }
}
