/** Read-only forecast using the same Angular analyzer as Release; never invokes semantic-release or push. */
import { gt, inc } from "semver";
import { analyzeCommits } from "./release-analyzer.mjs";
import { promotionHoldCap, selectPromotion } from "./promotion-policy.ts";
import {
  closedBetaCores,
  latestBetaTag,
  latestStableTag,
  nextBetaVersion,
  stableVersionForBeta,
} from "./release-version-policy.mjs";

async function analyze(commits, version) {
  return analyzeCommits(
    {},
    {
      commits,
      lastRelease: { version },
      logger: { log() {} },
    },
  );
}

export async function forecastPromotion(input, plan, git) {
  if (plan.sha === input.target) return undefined;

  const tags = (...args) =>
    git("tag", "--list", "v*", ...args)
      .split("\n")
      .filter(Boolean);

  const publicTags = input.publicReleaseTags ?? [];
  const exact = tags("--points-at", plan.sha);

  if (input.path === "next-main") return stableVersionForBeta(publicTags, exact);

  const reachable = tags("--merged", plan.sha);
  const stable = latestStableTag(reachable);

  if (!stable) return undefined; // Same bootstrap guard as semantic-release.mjs.
  const closed = closedBetaCores(tags(), publicTags, tags("--points-at", "origin/main"));
  const published = new Set(publicTags);
  const isEligible = (tag) => published.has(tag) || !closed.has(tag.slice(1).split("-")[0]);
  const beta = latestBetaTag(reachable.filter(isEligible));
  const reserved = latestBetaTag(exact.filter(isEligible));

  if (reserved) return published.has(reserved) ? undefined : reserved.slice(1);
  const base = beta && gt(beta, stable) ? beta : stable;
  const baseVersion = base.slice(1);

  if (
    !(await analyze(
      plan.included.map((commit) => ({ message: commit.message, hash: commit.sha })),
      baseVersion,
    ))
  )
    return undefined;
  const hashes = git("rev-list", `${base}..${plan.sha}`).split("\n").filter(Boolean);

  const bump = await analyze(
    hashes.map((sha) => ({ message: git("show", "-s", "--format=%B", sha), hash: sha })),
    baseVersion,
  );

  if (!bump) return undefined;

  return nextBetaVersion(`${inc(baseVersion, bump)}-beta.1`, reachable, publicTags, closed);
}

/** Time-only forecast against the same read-only snapshot; never assumes CI or labels will change. */
export async function forecastPromotionWindow(input, plan, git) {
  if (plan.sha !== input.target || input.paused || input.blockers.length) return undefined;

  const thresholds = input.commits.map(
    (commit) => (input.path === "dev-next" ? commit.landedAt : (commit.release?.readyAt ?? Infinity)) + input.soakMs,
  );

  // Expiry is strict (> cap), so the first eligible instant is one millisecond past the boundary.
  thresholds.push(...plan.holds.map((hold) => hold.since + promotionHoldCap(input) + 1));

  const times = [...new Set(thresholds)].filter((at) => Number.isFinite(at) && at > input.now).sort((a, b) => a - b);

  for (const at of times) {
    const future = selectPromotion({ ...input, now: at });
    const version = await forecastPromotion(input, future, git);

    if (version) return { at, sha: future.sha, version };
  }

  return undefined;
}
