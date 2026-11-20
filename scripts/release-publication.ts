import { git, pages, repository } from "./release-github.ts";
import { compareTags } from "./version.ts";
import {
  closedBetaCores,
  firstNightlyAfterRelease,
  latestBetaTag,
  latestStableTag,
  publishedReleaseTags,
} from "./release-version-policy.mjs";

const github = { git, pages };

function tagCommit(tag: string, runGit: typeof git): string {
  const ref = `refs/tags/${tag}`;
  runGit("fetch", "--quiet", "--no-tags", "origin", `+${ref}:${ref}`);

  return runGit("rev-parse", `${ref}^{commit}`);
}

export function requireStableBeta(repo: string, tag: string, sha: string, adapters = github): void {
  const tags = publishedReleaseTags(adapters.pages(`repos/${repo}/releases?per_page=100`));

  // An already visible tag can be retried to finish unrelated publication jobs.
  if (tags.includes(tag)) return;
  const beta = latestBetaTag(tags.filter((candidate) => candidate.startsWith(`${tag}-beta.`)));

  if (!beta) throw new Error(`Stable ${tag} requires a public beta of the same version`);
  const betaSha = tagCommit(beta, adapters.git);

  if (betaSha !== sha) throw new Error(`Stable ${tag} must match ${beta} (${betaSha}); planned ${sha}`);
}

export function requireNightlyPublication(repo: string, tag: string, sha: string, adapters = github): void {
  const tags = publishedReleaseTags(adapters.pages(`repos/${repo}/releases?per_page=100`));
  const minimum = firstNightlyAfterRelease(tags);

  if (minimum && compareTags(tag, `v${minimum}`) < 0)
    throw new Error(
      `${tag} is from a closed nightly series; nightly requires ${minimum} or later. Re-plan the release.`,
    );

  for (const published of [latestBetaTag(tags), latestStableTag(tags)]) {
    if (!published) continue;
    const publishedSha = tagCommit(published, adapters.git);

    if (adapters.git("merge-base", sha, publishedSha) === sha)
      throw new Error(`Nightly commit ${sha} is already contained in ${published}`);
  }
}

export function requireBetaPublication(repo: string, tag: string, adapters = github): void {
  const tags = publishedReleaseTags(adapters.pages(`repos/${repo}/releases?per_page=100`));
  const latestBeta = latestBetaTag(tags);
  const stable = latestStableTag(tags);
  const core = tag.slice(1).replace(/-beta\.\d+$/, "");

  if (stable && compareTags(`v${core}`, stable) <= 0) throw new Error(`${tag} is already covered by stable ${stable}`);

  if (latestBeta && compareTags(tag, latestBeta) <= 0)
    throw new Error(`${tag} is superseded by public beta ${latestBeta}`);

  if (latestBeta && (!stable || compareTags(latestBeta, stable) > 0)) {
    const line = tag.split(".", 2).join(".");

    if (line !== latestBeta.split(".", 2).join("."))
      throw new Error(`${tag} must wait for the active beta line ${latestBeta} to ship to stable`);
  }

  adapters.git("fetch", "--quiet", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  const gitTags = adapters.git("tag", "--list", "v*").split("\n");
  const mainHeadTags = adapters.git("tag", "--points-at", "origin/main").split("\n");

  if (closedBetaCores(gitTags, tags, mainHeadTags).has(core))
    throw new Error(`${tag} is already being promoted to stable. Re-plan the beta on the next patch version.`);
}

if (import.meta.main) {
  const [sha, tag] = process.argv.slice(2);

  if (!sha || !tag) throw new Error("Usage: bun scripts/release-publication.ts <commit SHA> <planned stable tag>");
  requireStableBeta(repository(), tag, sha);
}
