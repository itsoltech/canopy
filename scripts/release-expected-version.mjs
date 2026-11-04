/**
 * semantic-release plugin: with EXPECTED_VERSION set, refuse a different next version before the tag is created.
 * The release workflow plans the version with a dry run and builds artifacts while the checks run; the real
 * release after the checks must publish exactly that version (docs/release.md).
 */
export function verifyRelease(_config, { nextRelease }) {
  const expected = process.env.EXPECTED_VERSION;

  if (expected && nextRelease.version !== expected) {
    throw new Error(
      `Planned ${expected} but the release would be ${nextRelease.version}; nothing was tagged. Re-run all jobs to plan again.`,
    );
  }
}
