/**
 * Stages assets on a draft. --publish requires every supported desktop feed and installer, verifies the
 * uploaded bytes, then makes the release visible. Published releases are immutable on job reruns.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { api, git, pages, repository } from "./release-github.ts";
import { resolveVersion } from "./version.ts";

const GENERATED = ["checksums.txt", "manifest.json"];

export interface UploadedAsset {
  name: string;
  size: number;
  state: string;
  digest: string | null;
}

export interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

function isAsset<T>(value: T): value is T & UploadedAsset {
  return (
    !!value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    "size" in value &&
    typeof value.size === "number" &&
    "state" in value &&
    typeof value.state === "string" &&
    "digest" in value &&
    (value.digest === null || typeof value.digest === "string")
  );
}

function isRelease<T>(value: T): value is T & Release {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "number" &&
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    "draft" in value &&
    typeof value.draft === "boolean" &&
    "prerelease" in value &&
    typeof value.prerelease === "boolean"
  );
}

export interface ReleaseUploadOptions {
  repo: string;
  tag: string;
  version: string;
  channel: string;
  sha: string;
  publish: boolean;
}

export interface ReleaseUploadAdapters {
  find: (repo: string, tag: string) => Release | undefined;
  create: (options: ReleaseUploadOptions) => void;
  assets: (repo: string, id: number) => UploadedAsset[];
  upload: (repo: string, tag: string, paths: string[]) => void;
  publish: (repo: string, id: number, stable: boolean) => void;
}

const github: ReleaseUploadAdapters = {
  find: (repo, tag) => {
    // The tag endpoint does not reliably find drafts. Authenticated listing includes them.
    const releases = pages(`repos/${repo}/releases?per_page=100`);

    if (!releases.every(isRelease)) throw new Error("Invalid GitHub releases response");

    return releases.find((release) => release.tag_name === tag);
  },
  create: ({ repo, tag, version, channel }) => {
    execFileSync(
      "gh",
      [
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--verify-tag",
        "--draft",
        "--latest=false",
        "--title",
        `Canopy ${version}`,
        "--generate-notes",
        ...(channel === "stable" ? [] : ["--prerelease"]),
      ],
      { stdio: "inherit" },
    );
  },
  assets: (repo, id) => {
    const assets = pages(`repos/${repo}/releases/${id}/assets?per_page=100`);

    if (!assets.every(isAsset)) throw new Error("Invalid GitHub assets response");

    return assets;
  },
  upload: (repo, tag, paths) => {
    execFileSync("gh", ["release", "upload", tag, ...paths, "--repo", repo, "--clobber"], { stdio: "inherit" });
  },
  publish: (repo, id, stable) => {
    api(`repos/${repo}/releases/${id}`, "PATCH", { draft: false, make_latest: stable ? "legacy" : "false" });
  },
};

/** Missing required targets must leave the entire release hidden, including gateway/worker updates. */
function requireComplete(names: readonly string[], version: string, channel: string): void {
  const required = [...GENERATED];

  for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"]) {
    for (const app of ["gateway", "worker"])
      required.push(`canopy-${app}-${target}${target.startsWith("windows") ? ".exe" : ""}`);
  }

  const installers = [
    "linux-x64.AppImage",
    "linux-x64.deb",
    "darwin-arm64.dmg",
    "darwin-arm64.zip",
    "darwin-arm64.dmg.blockmap",
    "darwin-arm64.zip.blockmap",
    "windows-x64.exe",
    "windows-x64.exe.blockmap",
  ];

  const suffixes = ["", "-mac", "-linux"];

  // The experimental target is optional, but if present it must also be installable.
  if (names.some((name) => name.startsWith(`Canopy-${version}-linux-arm64.`))) {
    installers.push("linux-arm64.AppImage", "linux-arm64.deb");
    suffixes.push("-linux-arm64");
  }

  required.push(...installers.map((name) => `Canopy-${version}-${name}`));

  const channels =
    channel === "stable" ? ["latest", "beta", "nightly"] : channel === "beta" ? ["beta", "nightly"] : ["nightly"];

  for (const feed of channels) for (const suffix of suffixes) required.push(`${feed}${suffix}.yml`);
  const missing = required.filter((name) => !names.includes(name));

  if (missing.length) throw new Error(`Release is incomplete: ${missing.join(", ")}`);
}

async function localAssets(directory: string, names: readonly string[]): Promise<UploadedAsset[]> {
  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      const hash = createHash("sha256");

      for await (const chunk of Bun.file(path).stream()) hash.update(chunk);

      return { name, size: statSync(path).size, state: "uploaded", digest: `sha256:${hash.digest("hex")}` };
    }),
  );
}

function matches(expected: UploadedAsset, actual: UploadedAsset | undefined): boolean {
  return actual?.state === "uploaded" && actual.size === expected.size && actual.digest === expected.digest;
}

export async function uploadRelease(
  directory: string,
  options: ReleaseUploadOptions,
  adapters: ReleaseUploadAdapters = github,
): Promise<void> {
  const { repo, tag, channel, version, sha } = options;
  const info = resolveVersion({ tag, commit: sha });

  if (tag !== `v${version}` || info.channel !== channel) throw new Error("Release version/channel must match tag");

  const names = readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();

  for (const name of GENERATED)
    if (!existsSync(join(directory, name)))
      throw new Error(`${name} is missing; run scripts/release-manifest.ts first`);

  if (options.publish) requireComplete(names, version, channel);
  let release = adapters.find(repo, tag);

  if (!release) {
    adapters.create(options);
    release = adapters.find(repo, tag);
  }

  if (!release || release.tag_name !== tag || release.prerelease !== (channel !== "stable"))
    throw new Error(`Release ${tag} is missing or has the wrong prerelease flag`);

  if (!release.draft) {
    // A lost publish response or a later job failure must never trigger --clobber on a visible release.
    console.info(`${tag} is already published; leaving all assets unchanged`);

    return;
  }

  const expected = await localAssets(directory, names);
  const uploaded = adapters.assets(repo, release.id);

  const pending = expected.filter(
    (asset) =>
      !matches(
        asset,
        uploaded.find((other) => other.name === asset.name),
      ),
  );

  for (const group of [
    pending.filter((asset) => !asset.name.endsWith(".yml") && !GENERATED.includes(asset.name)),
    pending.filter((asset) => asset.name.endsWith(".yml")),
    ...GENERATED.map((name) => pending.filter((asset) => asset.name === name)),
  ]) {
    if (group.length)
      adapters.upload(
        repo,
        tag,
        group.map((asset) => join(directory, asset.name)),
      );
  }

  const verified = adapters.assets(repo, release.id);

  for (const asset of expected)
    if (
      !matches(
        asset,
        verified.find((other) => other.name === asset.name),
      )
    )
      throw new Error(`Uploaded asset failed verification: ${asset.name}`);

  // The only visibility change. All files, including channel aliases and manifest.json, already exist.
  if (options.publish) adapters.publish(repo, release.id, channel === "stable");
  console.info(`${tag}: ${expected.length} assets verified; ${options.publish ? "published" : "draft"}`);
}

if (import.meta.main) {
  const [directory, flag] = process.argv.slice(2);
  const tag = process.env["CANOPY_RELEASE_TAG"];
  const version = process.env["CANOPY_VERSION"];
  const channel = process.env["CANOPY_CHANNEL"];
  const sha = process.env["GITHUB_SHA"];

  if (!directory || !tag || !version || !channel || !sha || (flag && flag !== "--publish"))
    throw new Error(
      "Usage: CANOPY_RELEASE_TAG=… CANOPY_VERSION=… CANOPY_CHANNEL=… GITHUB_SHA=… bun scripts/release-upload.ts <assets dir> [--publish]",
    );
  git("fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${tag}:refs/tags/${tag}`);

  if (git("rev-parse", `${tag}^{commit}`) !== sha) throw new Error(`${tag} does not point at ${sha}`);
  await uploadRelease(resolve(directory), {
    repo: repository(),
    tag,
    version,
    channel,
    sha,
    publish: flag === "--publish",
  });
}
