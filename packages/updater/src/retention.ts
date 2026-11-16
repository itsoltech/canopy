import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, type ReleaseManifest, type ReleaseSourceOptions } from "./release.ts";

const RETAINED_RELEASES = 3;

interface CachedRelease {
  name: string;
  manifest: ReleaseManifest;
  modified: number;
}

/** Call only while mirror writes are excluded. Unknown files and partial downloads are never removed. */
export async function pruneReleaseCache(
  directory: string,
  protectedVersions: ReadonlySet<string>,
  options: ReleaseSourceOptions = {},
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const releases: CachedRelease[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/^manifest-.+\.json$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const manifest = parseManifest(JSON.parse(await readFile(path, "utf8")), options);

    if (entry.name !== `manifest-${encodeURIComponent(manifest.version)}.json`)
      throw new Error("Cached release manifest does not match its filename");
    releases.push({ name: entry.name, manifest, modified: (await stat(path)).mtimeMs });
  }

  // A missing manifest is not an offline-usable cache entry. The mirror persists it before any artifact,
  // so unpublished builds and rollback versions never mirrored here must not disable all cleanup.
  // An existing but invalid manifest still throws above, before any deletion.
  releases.sort((left, right) => right.modified - left.modified || left.name.localeCompare(right.name));
  const retained = new Set(releases.filter((release) => protectedVersions.has(release.manifest.version)));

  for (const release of releases) {
    if (retained.size >= RETAINED_RELEASES) break;
    retained.add(release);
  }

  const hashes = new Set(
    [...retained].flatMap((release) =>
      release.manifest.assets.filter((asset) => asset.app === "worker").map((asset) => asset.sha256.toLowerCase()),
    ),
  );

  for (const entry of entries) {
    if (entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !hashes.has(entry.name))
      await rm(join(directory, entry.name), { force: true });
  }

  for (const release of releases) {
    if (!retained.has(release)) await rm(join(directory, release.name), { force: true });
  }
}
