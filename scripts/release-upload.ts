/**
 * Uploads `<assets dir>` to the GitHub release CANOPY_RELEASE_TAG (docs/release.md, "Publikacja w dwóch etapach").
 * The tag must point at GITHUB_SHA. Files go up in the order the updaters rely on, and every step can be repeated:
 *   1. binaries, desktop installers and blockmaps (`--clobber`),
 *   2. desktop feeds `*.yml`: a feed is what makes the desktop updater choose the release,
 *   3. checksums.txt, then manifest.json: what makes the install script and gateways/workers choose it.
 * The last two replace an existing asset by uploading `<name>.next` and renaming it, so a published release
 * is without them only between two API calls.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api, git, repository } from "./release-github.ts";

const GENERATED = ["checksums.txt", "manifest.json"];

interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { id: number; name: string }[];
}

function isAsset(value: unknown): value is Release["assets"][number] {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "number" &&
    "name" in value &&
    typeof value.name === "string"
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
    typeof value.prerelease === "boolean" &&
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(isAsset)
  );
}

function gh(...args: string[]): void {
  execFileSync("gh", args, { stdio: ["ignore", "inherit", "inherit"] });
}

function release(repo: string, tag: string): Release | undefined {
  try {
    const value = api(`repos/${repo}/releases/tags/${tag}`);

    return isRelease(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Upload under a temporary name, then swap it in: the old file stays published until the rename. */
function replace(repo: string, tag: string, path: string, name: string): void {
  const staging = mkdtempSync(join(tmpdir(), "canopy-release-upload-"));

  try {
    const staged = join(staging, `${name}.next`);
    copyFileSync(path, staged);
    gh("release", "upload", tag, staged, "--clobber");
    const assets = release(repo, tag)?.assets ?? [];
    const next = assets.find((asset) => asset.name === `${name}.next`);

    if (!next) throw new Error(`Uploaded ${name}.next is missing from ${tag}`);
    const current = assets.find((asset) => asset.name === name);

    if (current) api(`repos/${repo}/releases/assets/${current.id}`, "DELETE");
    api(`repos/${repo}/releases/assets/${next.id}`, "PATCH", { name });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const directory = resolve(process.argv[2] ?? "");
  const tag = process.env["CANOPY_RELEASE_TAG"];
  const version = process.env["CANOPY_VERSION"];
  const channel = process.env["CANOPY_CHANNEL"];
  const sha = process.env["GITHUB_SHA"];

  if (!process.argv[2] || !tag || !version || !channel || !sha)
    throw new Error(
      "Usage: CANOPY_RELEASE_TAG=… CANOPY_VERSION=… CANOPY_CHANNEL=… GITHUB_SHA=… bun scripts/release-upload.ts <assets dir>",
    );

  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match version ${version}`);

  for (const name of GENERATED)
    if (!existsSync(join(directory, name)))
      throw new Error(`${name} is missing; run scripts/release-manifest.ts first`);
  // Never attach this run's assets to a tag that names another commit.
  git("fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${tag}:refs/tags/${tag}`);

  if (git("rev-parse", `${tag}^{commit}`) !== sha) throw new Error(`${tag} does not point at ${sha}`);

  const repo = repository();
  const existing = release(repo, tag);

  if (!existing) {
    // Branch releases come from semantic-release; a manual stable tag gets its release here.
    gh(
      "release",
      "create",
      tag,
      "--verify-tag",
      "--title",
      `Canopy ${version}`,
      "--generate-notes",
      ...(channel === "stable" ? [] : ["--prerelease", "--latest=false"]),
    );
  } else if (existing.draft || existing.prerelease !== (channel !== "stable")) {
    throw new Error(`Release ${tag} is a draft or has the wrong prerelease flag`);
  }

  const names = readdirSync(directory)
    .filter((name) => !GENERATED.includes(name))
    .sort();

  const assets = names.filter((name) => !name.endsWith(".yml")).map((name) => join(directory, name));
  const feeds = names.filter((name) => name.endsWith(".yml")).map((name) => join(directory, name));

  if (assets.length) gh("release", "upload", tag, ...assets, "--clobber");

  if (feeds.length) gh("release", "upload", tag, ...feeds, "--clobber");

  for (const name of GENERATED) replace(repo, tag, join(directory, name), name);
  console.info(`${tag}: ${assets.length} assets, ${feeds.length} feeds, checksums.txt and manifest.json`);
}
