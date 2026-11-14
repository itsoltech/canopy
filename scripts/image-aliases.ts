/**
 * Points the channel aliases of the GHCR images (`nightly`, `beta`, `stable`, `latest`, `vX`, `vX.Y`) at the
 * already pushed `vX.Y.Z` images, only forward: an alias that names a newer version stays (docs/release.md).
 * Runs in release.yml `publish-desktop` after publication and `docker login`; version and tag as in scripts/release-manifest.ts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { compareTags, resolveVersion } from "./version.ts";

const VERSION_ANNOTATION = "org.opencontainers.image.version";

function isIndex(value: unknown): value is { annotations?: Record<string, string> } {
  return (
    !!value &&
    typeof value === "object" &&
    (!("annotations" in value) ||
      value.annotations === undefined ||
      (!!value.annotations &&
        typeof value.annotations === "object" &&
        Object.values(value.annotations).every(isString)))
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Version annotated on the image index of `reference`; null when the tag does not exist, "" when unannotated. */
function aliasVersion(reference: string): string | null {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", reference], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    if (/not found|unknown/i.test(result.stderr)) return null;
    throw new Error(`Cannot inspect ${reference}: ${result.stderr.trim()}`);
  }

  const index: unknown = JSON.parse(result.stdout);

  if (!isIndex(index)) throw new Error(`Cannot inspect ${reference}: invalid image index`);

  return index.annotations?.[VERSION_ANNOTATION] ?? "";
}

if (import.meta.main) {
  const tag = process.env["CANOPY_RELEASE_TAG"];
  const namespace = process.env["IMAGE_NAMESPACE"];
  const commit = process.env["GITHUB_SHA"];

  if (!tag || !namespace || !commit || tag !== `v${process.env["CANOPY_VERSION"]}`)
    throw new Error("Set CANOPY_RELEASE_TAG, CANOPY_VERSION (matching), IMAGE_NAMESPACE and GITHUB_SHA");
  const aliases = resolveVersion({ tag, commit }).dockerTags.filter((alias) => alias !== tag);

  // canopy-web is retired (the gateway image serves the web); its aliases stay on its last release.
  for (const app of ["gateway", "worker"]) {
    const image = `${namespace}/canopy-${app}`;

    for (const alias of aliases) {
      const current = aliasVersion(`${image}:${alias}`);

      if (current && compareTags(`v${current}`, tag) >= 0) {
        console.info(`${image}:${alias} stays at ${current} (not older than ${tag})`);
        continue;
      }

      execFileSync("docker", ["buildx", "imagetools", "create", "--tag", `${image}:${alias}`, `${image}:${tag}`], {
        stdio: "inherit",
      });
      console.info(`${image}:${alias} → ${tag}${current === "" ? " (previous alias had no version annotation)" : ""}`);
    }
  }
}
