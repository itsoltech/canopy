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

const BINARY = /^canopy-(gateway|worker)-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/;
const DESKTOP = /^Canopy-.+-(linux|darwin|windows)-(x64|arm64)\.(AppImage|deb|dmg|zip|exe)$/;
const GENERATED = new Set(["checksums.txt", "manifest.json"]);

/** app/os/arch of a release asset name, or undefined when it is not one. */
export function classify(name: string): Pick<ManifestAsset, "app" | "os" | "arch"> | undefined {
  const binary = name.match(BINARY);
  if (binary) {
    if ((binary[2] === "windows") !== (binary[4] === ".exe")) return undefined;
    return { app: binary[1] as "gateway" | "worker", os: binary[2] as ManifestAsset["os"], arch: binary[3] as ManifestAsset["arch"] };
  }
  const desktop = name.match(DESKTOP);
  return desktop ? { app: "desktop", os: desktop[1] as ManifestAsset["os"], arch: desktop[2] as ManifestAsset["arch"] } : undefined;
}

/**
 * Protocol versions from packages/domain/src/release/protocol.ts (the self-update work adds it); 1 until it exists.
 * Imported by path so this script does not depend on the file being there.
 */
async function protocolVersions(): Promise<ReleaseManifest["protocol"]> {
  const path = join(root, "packages/domain/src/release/protocol.ts");
  if (!existsSync(path)) return { worker_link: 1, update: 1 };
  const constants = (await import(path)) as { WORKER_LINK_PROTOCOL?: number; UPDATE_PROTOCOL?: number };
  return { worker_link: constants.WORKER_LINK_PROTOCOL ?? 1, update: constants.UPDATE_PROTOCOL ?? 1 };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

export async function releaseManifest(directory: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<ReleaseManifest> {
  const info = currentVersion(env);
  const version = env["CANOPY_VERSION"] || info.version;
  const tag = env["CANOPY_RELEASE_TAG"] || info.releaseTag;
  if (!tag) throw new Error("Manifest needs an immutable release tag (or CANOPY_VERSION and CANOPY_RELEASE_TAG)");
  const release = resolveVersion({ tag, commit: info.commit });
  const channel = env["CANOPY_CHANNEL"] || release.channel;
  if (version !== release.version || channel !== release.channel) throw new Error("Manifest version/channel must match its release tag");
  const repository = env["GITHUB_REPOSITORY"] || "itsoltech/canopy";
  const names = readdirSync(directory).filter((name) => !GENERATED.has(name) && statSync(join(directory, name)).isFile()).sort();
  const assets: ManifestAsset[] = [];
  for (const name of names) {
    const kind = classify(name);
    if (!kind) throw new Error(`Not a release asset: ${name}`);
    const path = join(directory, name);
    assets.push({ ...kind, name, url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`, sha256: await sha256(path), size: statSync(path).size });
  }
  return {
    schema: 1,
    version,
    channel,
    commit: info.commit,
    published_at: new Date().toISOString(),
    protocol: await protocolVersions(),
    assets,
  };
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: bun scripts/release-manifest.ts <assets dir>");
  const manifest = await releaseManifest(resolve(directory));
  writeFileSync(join(directory, "checksums.txt"), manifest.assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""));
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.info(`manifest.json: ${manifest.version} (${manifest.channel}), ${manifest.assets.length} assets`);
}
