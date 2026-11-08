export default {
  branches: [
    "main",
    { name: "next", channel: "beta", prerelease: "beta" },
    { name: "dev", channel: "nightly", prerelease: "nightly" },
  ],
  tagFormat: "v${version}",
  // GitHub's addChannel hook can create a public release even with draftRelease enabled.
  // Promotions build their own version; only release-upload.ts may make it visible.
  addChannel: [],
  plugins: [
    // Delegates to commit-analyzer (Angular), adjusting breaking changes only while major is zero.
    "./scripts/release-analyzer.mjs",
    // Refuses a version other than the one the workflow planned and built (no-op without EXPECTED_VERSION).
    "./scripts/release-expected-version.mjs",
    ["@semantic-release/release-notes-generator", { preset: "angular" }],
    [
      "@semantic-release/github",
      { draftRelease: true, successComment: false, failComment: false, failTitle: false, releasedLabels: false },
    ],
  ],
};
