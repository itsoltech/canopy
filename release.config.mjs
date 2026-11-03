export default {
  branches: [
    "main",
    { name: "next", channel: "beta", prerelease: "beta" },
    { name: "dev", channel: "nightly", prerelease: "nightly" },
  ],
  tagFormat: "v${version}",
  plugins: [
    // Delegates to commit-analyzer (Angular), adjusting breaking changes only while major is zero.
    "./scripts/release-analyzer.mjs",
    ["@semantic-release/release-notes-generator", { preset: "angular" }],
    ["@semantic-release/github", { successComment: false, failComment: false, failTitle: false, releasedLabels: false }],
  ],
};
