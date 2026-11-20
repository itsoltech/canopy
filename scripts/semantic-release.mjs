/**
 * CI entry point: bootstrap is explicit; tag creation does not start another Actions run.
 * `--dry-run` plans the version without tagging (release.yml `plan`); the real run publishes it after the checks.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import semanticRelease from "semantic-release";
import { generateReleaseNotes } from "./generate-release-notes.mjs";
import { analyzeCommits } from "./release-analyzer.mjs";
import { githubDraft, listGithubReleases } from "./release-draft.mjs";
import { recoverRelease } from "./release-recovery.mjs";
import {
  latestBetaTag,
  latestStableTag,
  nightlyBaseTag,
  publishedReleaseTags,
  releaseVersionPolicy,
} from "./release-version-policy.mjs";
import config from "../release.config.mjs";

const dryRun = process.argv.includes("--dry-run");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const tags = (...args) =>
  git("tag", "--list", ...args)
    .split("\n")
    .filter(Boolean);

const readNotes = () =>
  new Map(
    git("for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/semantic-release*")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")),
  );

const output = (values) => {
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  console.log(lines);
};

const sha = git("rev-parse", "HEAD");

if (process.env.EXPECTED_SHA && sha !== process.env.EXPECTED_SHA)
  throw new Error("Checkout does not match EXPECTED_SHA; refusing a different commit");

function verifyAncestry(branch) {
  git("fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

  try {
    git("merge-base", "--is-ancestor", sha, `refs/remotes/origin/${branch}`);
  } catch {
    throw new Error("EXPECTED_SHA is no longer an ancestor of the release branch; refusing rewritten history");
  }
}

function isAncestor(older, newer) {
  const status = spawnSync("git", ["merge-base", "--is-ancestor", older, newer]).status;

  if (status === 0 || status === 1) return status === 0;
  throw new Error(`Could not check release ancestry for ${older} and ${newer}`);
}

// semantic-release's push-access probe rejects an older HEAD, including in dry runs. A private
// mirror gives it the pinned branch while preserving all other branches, tags and channel notes.
export async function releasePinned({
  dryRun = false,
  createDraft = githubDraft,
  listReleases = listGithubReleases,
} = {}) {
  const branch = process.env.RELEASE_BRANCH || process.env.GITHUB_REF_NAME;

  if (!["dev", "next", "main"].includes(branch)) throw new Error("Unsupported release branch");
  const releases = listReleases();
  git("fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/notes/*:refs/notes/*");
  verifyAncestry(branch);
  const publicTags = publishedReleaseTags(releases);
  const reachableTags = tags("--merged", sha);
  const exactTags = tags("--points-at", sha);

  const base =
    branch === "dev"
      ? nightlyBaseTag(reachableTags, publicTags, (older, newer) =>
          isAncestor(`refs/tags/${older}`, `refs/tags/${newer}`),
        )
      : undefined;

  const { stableVersion, keepReservation, options } = releaseVersionPolicy({
    branch,
    publicTags,
    gitTags: tags(),
    reachableTags,
    exactTags,
    mainHeadTags: tags("--points-at", "refs/remotes/origin/main"),
    baseTag: base,
  });

  if (branch === "dev") {
    const promoted = [latestStableTag(publicTags), latestBetaTag(publicTags)].filter(Boolean);

    for (const tag of promoted) {
      if (isAncestor(sha, `refs/tags/${tag}`)) {
        console.log(`Skipping nightly at ${sha}: it has no new changes beyond ${tag}; no new version is released.`);

        return false;
      }
    }
  }

  const repositoryUrl = git("remote", "get-url", "origin");

  const recovered = await recoverRelease({
    sha,
    branch,
    dryRun,
    releases,
    keepReservation,
    repositoryUrl,
    createDraft: async (body) => {
      verifyAncestry(branch);
      await createDraft(body);
    },
  });

  if (recovered !== undefined) return recovered;

  if (branch === "main" && !stableVersion) {
    console.log("Stable requires the latest public beta of its core at this commit; no new version is released.");

    return false;
  }

  const directory = mkdtempSync(join(tmpdir(), "canopy-release-snapshot-"));
  const mirror = join(directory, "origin.git");

  try {
    git("init", "--bare", mirror);
    git("push", mirror, "refs/remotes/origin/*:refs/heads/*", "refs/tags/*:refs/tags/*", "refs/notes/*:refs/notes/*");
    git("--git-dir", mirror, "update-ref", `refs/heads/${branch}`, sha);
    git("--git-dir", mirror, "symbolic-ref", "HEAD", `refs/heads/${branch}`);

    const originalNotes = readNotes();

    const result = await semanticRelease(
      {
        ...config,
        ...options,
        dryRun,
        ci: !process.argv.includes("--no-ci"),
        repositoryUrl: pathToFileURL(mirror).href,
        // GitHub needs the real owner/repo, and notes must keep their public compare/commit links.
        plugins: config.plugins
          .filter((plugin) => !Array.isArray(plugin) || plugin[0] !== "@semantic-release/github")
          .map((plugin) => {
            if (stableVersion && plugin === "./scripts/release-analyzer.mjs") {
              // A tested Beta may include a feature and its revert, which cancel during stable analysis.
              return { analyzeCommits: async (opts, context) => (await analyzeCommits(opts, context)) || "patch" };
            }

            if (Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator") {
              return {
                generateNotes: (_options, context) =>
                  generateReleaseNotes(plugin[1], { ...context, options: { ...context.options, repositoryUrl } }),
              };
            }

            return plugin;
          }),
      },
      { env: { ...process.env, GITHUB_REF: `refs/heads/${branch}` } },
    );

    if (result?.nextRelease && !dryRun) {
      verifyAncestry(branch);
      const { gitTag, gitHead, notes, version } = result.nextRelease;

      if (gitHead !== sha) throw new Error("Release does not match EXPECTED_SHA");

      // Atomic, non-forced refs only: never push a branch or replace an existing version.
      const noteRefs = [...readNotes()].flatMap(([ref, oid]) => (originalNotes.get(ref) !== oid ? [ref] : []));

      git("push", "--atomic", "origin", `refs/tags/${gitTag}`, ...noteRefs);

      await createDraft({
        tag_name: gitTag,
        target_commitish: sha,
        name: gitTag,
        body: notes,
        draft: true,
        prerelease: version.includes("-"),
        make_latest: "false",
      });
    }

    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main && process.env.GITHUB_REF_TYPE === "tag") {
  const tag = process.env.GITHUB_REF_NAME;

  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error("Manual tags must be stable vX.Y.Z");
  git("merge-base", "--is-ancestor", sha, "origin/main");
  output({ published: true, version: tag.slice(1), tag, channel: "stable" });
} else if (
  import.meta.main &&
  !git("tag", "--merged", "HEAD", "--list", "v*")
    .split("\n")
    .some((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
) {
  console.log("No stable bootstrap tag: push v0.1.0 before automatic releases.");
  output({ published: false });
} else if (import.meta.main) {
  const result = await releasePinned({ dryRun });

  if (!result) output({ published: false });
  else {
    const { version, gitTag: tag } = result.nextRelease;
    output({
      published: true,
      version,
      tag,
      channel: version.includes("-nightly.") ? "nightly" : version.includes("-beta.") ? "beta" : "stable",
    });
  }
}
