/**
 * semantic-release plugin: refuse an existing tag or a version different from EXPECTED_VERSION before tagging.
 * The release workflow plans the version with a dry run and builds artifacts while the checks run; the real
 * release after the checks must publish exactly that version (docs/release.md).
 */
import { spawnSync } from "node:child_process";

export function verifyRelease(_config, { nextRelease, cwd, env }) {
  const expected = process.env.EXPECTED_VERSION;

  if (expected && nextRelease.version !== expected) {
    throw new Error(
      `Planned ${expected} but the release would be ${nextRelease.version}; nothing was tagged. Re-run all jobs to plan again.`,
    );
  }

  const tag = nextRelease.gitTag;
  const existing = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd, env });

  if (existing.status === 0)
    throw new Error(
      `Release computed ${tag}, but that tag already exists; nothing was tagged. Check release channel metadata before retrying. Tags are immutable; refusing to skip a version.`,
    );

  if (existing.status !== 1) throw new Error(`Could not check whether ${tag} exists; refusing to tag`);
}
