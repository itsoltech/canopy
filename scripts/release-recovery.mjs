import { execFileSync } from "node:child_process";
import { gt, prerelease, rcompare, valid } from "semver";
import { generateReleaseNotes } from "./generate-release-notes.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const channelFor = (branch) => ({ dev: "nightly", next: "beta", main: null })[branch];

const matches = (tag, branch) => {
  const version = valid(tag.slice(1));
  const pre = version && prerelease(version);

  return tag.startsWith("v") && version && (pre ? pre[0] === channelFor(branch) : branch === "main");
};

/** A matching tag on this exact commit reserves the version even if the draft POST was lost. */
export async function recoverRelease({ sha, branch, dryRun, findRelease, createDraft, repositoryUrl }) {
  const candidates = git("tag", "--points-at", sha)
    .split("\n")
    .filter((tag) => matches(tag, branch));

  if (!candidates.length) return undefined;

  if (candidates.length !== 1) throw new Error("Multiple release tags on EXPECTED_SHA for this channel");
  const [gitTag] = candidates;
  const version = gitTag.slice(1);

  if (process.env.EXPECTED_VERSION && version !== process.env.EXPECTED_VERSION)
    throw new Error(`Planned ${process.env.EXPECTED_VERSION} but the existing tag is ${version}`);
  const existing = await findRelease(gitTag);

  if (existing && (existing.tag_name !== gitTag || existing.prerelease !== (branch !== "main")))
    throw new Error("Existing release does not match the reserved tag/channel");

  // A completed release is a no-op. A draft must resume all publication jobs.
  if (existing && !existing.draft) return false;
  const channel = channelFor(branch);
  const note = JSON.parse(git("notes", `--ref=semantic-release-${gitTag}`, "show", gitTag));

  if (!Array.isArray(note.channels) || !note.channels.includes(channel))
    throw new Error("Existing tag lacks semantic-release metadata for this channel");

  const previous = git("tag", "--merged", sha)
    .split("\n")
    .filter((tag) => {
      const v = valid(tag.slice(1));

      return tag.startsWith("v") && v && gt(version, v) && (!prerelease(v) || matches(tag, branch));
    })
    .sort((a, b) => rcompare(a.slice(1), b.slice(1)))[0];

  if (!previous) throw new Error("Recovery requires a previous release tag");
  const records = git("log", `${previous}..${sha}`, "--format=%H%x00%s").split("\n").filter(Boolean);

  const commits = records.map((record) => {
    const [hash, message] = record.split("\0");

    return { hash, message };
  });

  const nextRelease = { version, gitTag, gitHead: sha, channel };
  nextRelease.notes = await generateReleaseNotes(
    { preset: "angular" },
    {
      cwd: process.cwd(),
      commits,
      lastRelease: { gitTag: previous },
      nextRelease,
      options: { repositoryUrl },
    },
  );

  if (!dryRun && !existing)
    await createDraft({
      tag_name: gitTag,
      target_commitish: sha,
      name: gitTag,
      body: nextRelease.notes,
      draft: true,
      prerelease: branch !== "main",
      make_latest: "false",
    });
  console.log(`Resuming ${gitTag} at ${sha}; existing tag and channel notes are unchanged`);

  return { nextRelease };
}
