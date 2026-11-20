import type { PromotionAdapters } from "./promotion-data.ts";
import type { PromotionInput } from "./promotion-policy.ts";
import { analyzeCommits } from "./release-analyzer.mjs";
import { latestBetaTag, latestStableTag } from "./release-version-policy.mjs";
import { compareTags } from "./version.ts";

type ReleaseState = Pick<PromotionInput, "activeBeta" | "pendingRelease" | "releaseBlock">;

function publishedSha(tag: string, git: PromotionAdapters["git"]): string {
  const ref = `refs/tags/${tag}`;

  // The release may have become public since the workflow fetched tags.
  git("fetch", "--quiet", "--no-tags", "origin", `${ref}:${ref}`);

  return git("rev-parse", `${ref}^{commit}`);
}

async function hasUnpublishedChanges(tag: string, from: string, to: string, git: PromotionAdapters["git"]) {
  if (from === to) return false;
  const log = git("log", "-z", "--format=%H%x00%B", `${from}..${to}`);
  const fields = log.split("\0");
  const commits = [];

  for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ hash: fields[i]!, message: fields[i + 1]! });

  return !!(await analyzeCommits({}, { commits, lastRelease: { version: tag.slice(1) }, logger: { log() {} } }));
}

export async function promotionReleaseState(
  path: PromotionInput["path"],
  source: string,
  target: string,
  publicTags: string[],
  git: PromotionAdapters["git"],
): Promise<ReleaseState> {
  const stableTag = latestStableTag(publicTags);

  if (!stableTag) return { releaseBlock: "Waiting for a public stable release" };
  const betaTag = latestBetaTag(publicTags);

  const beta = betaTag ? { tag: betaTag, sha: publishedSha(betaTag, git) } : undefined;
  const activeBeta = beta && compareTags(beta.tag, stableTag) > 0 ? beta : undefined;
  const state: ReleaseState = activeBeta ? { activeBeta } : {};
  const stable = publishedSha(stableTag, git);

  if (path === "next-main" && (await hasUnpublishedChanges(stableTag, stable, target, git))) {
    state.pendingRelease = { branch: "main", sha: target };
    state.releaseBlock = `Waiting for stable publication on main at ${target}`;

    return state;
  }

  const next = path === "dev-next" ? target : source;

  // Older releases can leave a public beta ahead of stable on the same core.
  const baseline =
    activeBeta ??
    (beta && git("merge-base", stable, beta.sha) === stable && git("merge-base", beta.sha, next) === beta.sha
      ? beta
      : { tag: stableTag, sha: stable });

  if (await hasUnpublishedChanges(baseline.tag, baseline.sha, next, git)) {
    state.pendingRelease = { branch: "next", sha: next };
    state.releaseBlock = `Waiting for beta publication on next at ${next}`;
  } else if (path === "dev-next" && activeBeta) {
    state.releaseBlock = `Beta ${activeBeta.tag} is stabilizing; waiting for public stable ${activeBeta.tag.split("-")[0]}`;
  }

  return state;
}
