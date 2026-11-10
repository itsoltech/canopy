/**
 * CI entry point: bootstrap is explicit; tag creation does not start another Actions run.
 * `--dry-run` plans the version without tagging (release.yml `plan`); the real run publishes it after the checks.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import semanticRelease from "semantic-release";
import { generateNotes } from "@semantic-release/release-notes-generator";
import config from "../release.config.mjs";

const dryRun = process.argv.includes("--dry-run");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

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

// semantic-release's push-access probe rejects an older HEAD, including in dry runs. A private
// mirror gives it the pinned branch while preserving all other branches, tags and channel notes.
export async function releasePinned({ dryRun = false, createDraft = githubDraft } = {}) {
  const branch = process.env.GITHUB_REF_NAME;

  if (!["dev", "next", "main"].includes(branch)) throw new Error("Unsupported release branch");
  git("fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/notes/*:refs/notes/*");
  verifyAncestry(branch);
  const directory = mkdtempSync(join(tmpdir(), "canopy-release-snapshot-"));
  const mirror = join(directory, "origin.git");
  const repositoryUrl = git("remote", "get-url", "origin");

  try {
    git("init", "--bare", mirror);
    git("push", mirror, "refs/remotes/origin/*:refs/heads/*", "refs/tags/*:refs/tags/*", "refs/notes/*:refs/notes/*");
    git("--git-dir", mirror, "update-ref", `refs/heads/${branch}`, sha);
    git("--git-dir", mirror, "symbolic-ref", "HEAD", `refs/heads/${branch}`);

    const originalNotes = readNotes();

    const result = await semanticRelease({
      ...config,
      dryRun,
      ci: !process.argv.includes("--no-ci"),
      repositoryUrl: pathToFileURL(mirror).href,
      // GitHub needs the real owner/repo, and notes must keep their public compare/commit links.
      plugins: config.plugins
        .filter((plugin) => !Array.isArray(plugin) || plugin[0] !== "@semantic-release/github")
        .map((plugin) =>
          Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator"
            ? {
                generateNotes: (_options, context) =>
                  generateNotes(plugin[1], { ...context, options: { ...context.options, repositoryUrl } }),
              }
            : plugin,
        ),
    });

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

function githubDraft(body) {
  const repository = process.env.GITHUB_REPOSITORY;

  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY is required");
  execFileSync("gh", ["api", `repos/${repository}/releases`, "--method", "POST", "--input", "-"], {
    input: JSON.stringify(body),
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
  });
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
