/**
 * The one Canopy version of every app (docs/release.md).
 *
 * Release tags carry stable/beta/nightly versions. Untagged checkouts get an unpublished dev version.
 * The release workflow passes semantic-release's exact version to every build explicitly.
 *
 * `bun scripts/version.ts` prints JSON; `--github-output` appends `key=value` lines to $GITHUB_OUTPUT;
 * `--field version` prints one field.
 */
import { appendFileSync } from "node:fs";

export interface CanopyVersion {
  /** Semver without the `v`. */
  readonly version: string;
  /** stable, beta or nightly (unpublished checkouts use nightly). */
  readonly channel: string;
  /** Exact GitHub release tag; empty for unpublished checkouts. */
  readonly releaseTag: string;
  /** Whether the version is a prerelease. */
  readonly prerelease: boolean;
  readonly commit: string;
  readonly shortSha: string;
  /** Docker image tags (without the image name). */
  readonly dockerTags: readonly string[];
}

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function git(...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });

  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** Release metadata from an immutable tag; local builds never publish a rolling latest. */
export function resolveVersion(input: {
  readonly tag?: string | undefined;
  readonly lastTag?: string | undefined;
  readonly commit: string;
}): CanopyVersion {
  const shortSha = input.commit.slice(0, 7);
  const release = input.tag?.match(RELEASE_TAG);

  if (input.tag && release) {
    const [, major, minor, patch, pre] = release;
    const version = input.tag.slice(1);

    const channel =
      pre === undefined
        ? "stable"
        : pre.startsWith("beta.")
          ? "beta"
          : pre.startsWith("nightly.")
            ? "nightly"
            : undefined;

    if (!channel) throw new Error(`Unsupported release channel: ${pre}`);

    return {
      version,
      channel,
      releaseTag: input.tag,
      prerelease: pre !== undefined,
      commit: input.commit,
      shortSha,
      dockerTags:
        pre === undefined ? [input.tag, `v${major}.${minor}`, `v${major}`, "latest", "stable"] : [input.tag, channel],
    };
  }

  if (input.tag) throw new Error(`${input.tag} is not a release tag (vX.Y.Z or vX.Y.Z-pre)`);
  const last = input.lastTag?.match(RELEASE_TAG);
  const base = last ? `${last[1]}.${last[2]}.${last[3]}` : "0.0.0";

  return {
    version: `${base}-dev.${shortSha}`,
    channel: "nightly",
    releaseTag: "",
    prerelease: true,
    commit: input.commit,
    shortSha,
    dockerTags: [],
  };
}

/** The version of the checkout (CI: the pushed ref). */
export function currentVersion(env: Readonly<Record<string, string | undefined>> = process.env): CanopyVersion {
  const commit = env["GITHUB_SHA"] || git("rev-parse", "HEAD");

  if (!commit) throw new Error("Not a git checkout: set GITHUB_SHA or run inside the repository");
  const pushedTag = env["GITHUB_REF_TYPE"] === "tag" ? env["GITHUB_REF_NAME"] : undefined;

  const headTag =
    pushedTag ??
    git("tag", "--points-at", "HEAD", "--list", "v*")
      ?.split("\n")
      .filter((tag) => RELEASE_TAG.test(tag))
      .sort(compareTags)
      .at(-1);

  return resolveVersion({
    tag: headTag,
    lastTag: git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD"),
    commit,
  });
}

/** Semver order of `vX.Y.Z[-pre]` tags (a pre-release sorts before its release). */
export function compareTags(a: string, b: string): number {
  const [pa, pb] = [a.match(RELEASE_TAG), b.match(RELEASE_TAG)];

  if (!pa || !pb) return a.localeCompare(b);

  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);

    if (diff !== 0) return diff;
  }

  if (pa[4] === pb[4]) return 0;

  if (pa[4] === undefined) return 1;

  if (pb[4] === undefined) return -1;

  return pa[4].localeCompare(pb[4], "en", { numeric: true });
}

if (import.meta.main) {
  const info = currentVersion();
  const args = process.argv.slice(2);
  const field = args[args.indexOf("--field") + 1];

  if (args.includes("--field") && field) {
    const value = info[field as keyof CanopyVersion];

    if (value === undefined) throw new Error(`Unknown field ${field}`);
    console.log(Array.isArray(value) ? value.join(",") : String(value));
  } else if (args.includes("--github-output")) {
    const output = process.env["GITHUB_OUTPUT"];

    if (!output) throw new Error("GITHUB_OUTPUT is not set");

    const lines = Object.entries(info).map(
      ([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`,
    );

    appendFileSync(output, `${lines.join("\n")}\n`);
    console.log(lines.join("\n"));
  } else {
    console.log(JSON.stringify(info, null, 2));
  }
}
