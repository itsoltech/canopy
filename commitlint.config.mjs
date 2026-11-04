export default {
  extends: ["@commitlint/config-angular"],
  // Angular's analyzer uses the BREAKING CHANGE footer, not the Conventional Commits `!` shorthand.
  parserPreset: { parserOpts: { headerPattern: /^(\w*)(?:\((.*)\))?: (.*)$/ } },
  rules: {
    "type-enum": [
      2,
      "always",
      ["build", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test", "chore"],
    ],
  },
};
