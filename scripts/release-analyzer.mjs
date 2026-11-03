import { analyzeCommits as angularAnalyzer } from "@semantic-release/commit-analyzer";

export function analyzeCommits(config, context) {
  return angularAnalyzer({
    ...config,
    preset: "angular",
    // Never suppress major changes after 1.0.0; absent bootstrap tag keeps the default policy too.
    releaseRules: context.lastRelease.version?.startsWith("0.") ? [{ breaking: true, release: "minor" }] : [],
  }, context);
}
