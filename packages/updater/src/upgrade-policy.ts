import type { ReleaseCatalog } from "@canopy/domain/release/catalog";
import { releaseChannel } from "@canopy/domain/release/version";
import { compareVersions } from "./release.ts";

export class BinaryReleaseBlocked extends Error {}

/** Published builds use SemVer within a channel and commit ancestry between channels. */
export async function assertBinaryUpdateForward(
  catalog: ReleaseCatalog,
  currentVersion: string,
  target: { version: string; commit?: string },
): Promise<void> {
  const current = releaseChannel(currentVersion);
  const next = releaseChannel(target.version);

  if (current === "development" || next === "development") return;

  if (current === next) {
    if (compareVersions(target.version, currentVersion) < 0)
      throw new BinaryReleaseBlocked(`Release ${target.version} is older than ${currentVersion}. Try a newer release.`);

    return;
  }

  const ref = target.commit && /^[a-f0-9]{40}$/i.test(target.commit) ? target.commit : `v${target.version}`;

  if (!(await catalog.isForward(`v${currentVersion}`, ref)))
    throw new BinaryReleaseBlocked(
      `Release ${target.version} cannot be verified as an update from ${currentVersion}. Try a newer release.`,
    );
}
