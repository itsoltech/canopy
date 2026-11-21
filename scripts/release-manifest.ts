/**
 * `checksums.txt` and `manifest.json` of a GitHub release (docs/release.md, the contract the updaters read):
 * `bun scripts/release-manifest.ts <assets dir>` writes both into the directory, next to the assets.
 *
 * Assets: `canopy-<gateway|worker>-<os>-<arch>[.exe]` and the desktop installers
 * `Canopy-<version>-<os>-<arch>.<AppImage|deb|dmg|zip|exe>`; anything else is refused, so nothing unexpected
 * gets published. Version, channel and release tag come from scripts/version.ts (CANOPY_VERSION and
 * CANOPY_CHANNEL/CANOPY_RELEASE_TAG override them), the repository from GITHUB_REPOSITORY.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { currentVersion, resolveVersion } from "./version.ts";

const root = resolve(import.meta.dir, "..");

export interface ManifestAsset {
  readonly app: "gateway" | "worker" | "desktop";
  readonly os: "linux" | "darwin" | "windows";
  readonly arch: "x64" | "arm64";
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ReleaseManifest {
  readonly schema: 1;
  readonly version: string;
  readonly channel: string;
  readonly commit: string;
  readonly published_at: string;
  readonly protocol: { readonly worker_link: number; readonly update: number };
  readonly assets: readonly ManifestAsset[];
}

export const binaryLicenseSuffix = ".licenses.txt";
const BINARY = /^canopy-(gateway|worker)-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/;
const DESKTOP = /^Canopy-.+-(linux|darwin|windows)-(x64|arm64)\.(AppImage|deb|dmg|zip|exe)$/;
const GENERATED = new Set(["checksums.txt", "manifest.json"]);

function isDesktopUpdateMetadata(name: string, channel: string) {
  const feeds = channel === "stable" ? "latest|beta" : channel;

  return (
    new RegExp(`^(${feeds})(-mac|-linux(-arm64)?)?\\.yml$`).test(name) ||
    /^Canopy-.+-(linux|darwin|windows)-(x64|arm64)\.(AppImage|dmg|zip|exe)\.blockmap$/.test(name)
  );
}

/** app/os/arch of a release asset name, or undefined when it is not one. */
export function classify(name: string): Pick<ManifestAsset, "app" | "os" | "arch"> | undefined {
  const binary = name.match(BINARY);

  if (binary) {
    if ((binary[2] === "windows") !== (binary[4] === ".exe")) return undefined;

    return {
      // SAFETY: BINARY's capture groups enumerate exactly the app, OS and architecture unions below.
      app: binary[1] as "gateway" | "worker",
      // SAFETY: BINARY's second group is exactly linux|darwin|windows.
      os: binary[2] as ManifestAsset["os"],
      // SAFETY: BINARY's third group is exactly x64|arm64.
      arch: binary[3] as ManifestAsset["arch"],
    };
  }

  const desktop = name.match(DESKTOP);

  // SAFETY: DESKTOP's first and second groups enumerate the OS and architecture unions exactly.
  return desktop
    ? { app: "desktop", os: desktop[1] as ManifestAsset["os"], arch: desktop[2] as ManifestAsset["arch"] }
    : undefined;
}

// Read the versioned constants as data: a publisher can build an older revision with current tooling.
async function protocolVersions(revision?: string): Promise<ReleaseManifest["protocol"]> {
  const file = "packages/domain/src/release/protocol.ts";
  const path = join(root, file);

  if (revision) {
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Protocol source needs a full commit SHA");
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
    const ref = `${revision}:${file}`;

    if (git("cat-file", "-e", `${revision}^{commit}`).exitCode !== 0)
      throw new Error("Protocol source revision is missing");

    if (git("cat-file", "-e", ref).exitCode !== 0) return { worker_link: 1, update: 1 };
    const source = git("show", ref);

    if (source.exitCode !== 0) throw new Error("Could not read release protocol versions");
    const { stdout } = source;

    const version = (name: string) => {
      const match = new RegExp(`^export const ${name} = ([1-9]\\d*);$`, "m").exec(stdout.toString());
      const value = Number(match?.[1]);

      if (!Number.isSafeInteger(value)) throw new Error(`Invalid release protocol constant ${name}`);

      return value;
    };

    return { worker_link: version("WORKER_LINK_PROTOCOL"), update: version("UPDATE_PROTOCOL") };
  }

  if (!existsSync(path)) return { worker_link: 1, update: 1 };
  // SAFETY: The existing path is our repository-owned protocol module with these numeric constant exports.
  const constants = (await import(path)) as { WORKER_LINK_PROTOCOL?: number; UPDATE_PROTOCOL?: number };

  return { worker_link: constants.WORKER_LINK_PROTOCOL ?? 1, update: constants.UPDATE_PROTOCOL ?? 1 };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);

  return hash.digest("hex");
}

export async function releaseManifest(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ReleaseManifest> {
  const info = currentVersion(env);
  const version = env["CANOPY_VERSION"] || info.version;
  const tag = env["CANOPY_RELEASE_TAG"] || info.releaseTag;

  if (!tag) throw new Error("Manifest needs an immutable release tag (or CANOPY_VERSION and CANOPY_RELEASE_TAG)");
  const release = resolveVersion({ tag, commit: info.commit });
  const channel = env["CANOPY_CHANNEL"] || release.channel;

  if (version !== release.version || channel !== release.channel)
    throw new Error("Manifest version/channel must match its release tag");
  const repository = env["GITHUB_REPOSITORY"] || "itsoltech/canopy";

  const names = readdirSync(directory)
    .filter((name) => !GENERATED.has(name) && statSync(join(directory, name)).isFile())
    .sort();

  const assets: ManifestAsset[] = [];
  const files = new Set(names);

  for (const name of names) {
    const kind = classify(name);

    // Desktop updater metadata has no single app/os/arch; keep it outside the frozen
    // gateway/worker manifest format. checksums.txt covers these files as well.
    if (!kind && isDesktopUpdateMetadata(name, channel)) continue;

    if (name.endsWith(binaryLicenseSuffix)) {
      const binary = name.slice(0, -binaryLicenseSuffix.length);

      if (BINARY.test(binary) && classify(binary) && files.has(binary)) continue;
    }

    if (!kind) throw new Error(`Not a release asset: ${name}`);
    const path = join(directory, name);
    assets.push({
      ...kind,
      name,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
      sha256: await sha256(path),
      size: statSync(path).size,
    });
  }

  return {
    schema: 1,
    version,
    channel,
    commit: info.commit,
    published_at: new Date().toISOString(),
    protocol: await protocolVersions(env["CANOPY_PROTOCOL_REVISION"]),
    assets,
  };
}

/**
 * Writes `checksums.txt` and `manifest.json` for everything in the directory. Release publication runs it twice
 * (docs/release.md): with the server assets, then again once desktop assets are added; the server entries stay the same.
 */
export async function writeReleaseFiles(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ReleaseManifest> {
  const manifest = await releaseManifest(directory, env);

  const names = readdirSync(directory)
    .filter((name) => !GENERATED.has(name) && statSync(join(directory, name)).isFile())
    .sort();

  const checksums = await Promise.all(names.map(async (name) => `${await sha256(join(directory, name))}  ${name}\n`));
  writeFileSync(join(directory, "checksums.txt"), checksums.join(""));
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

if (import.meta.main) {
  const directory = process.argv[2];

  if (!directory) throw new Error("Usage: bun scripts/release-manifest.ts <assets dir>");
  const manifest = await writeReleaseFiles(resolve(directory));
  console.info(`manifest.json: ${manifest.version} (${manifest.channel}), ${manifest.assets.length} assets`);
}
