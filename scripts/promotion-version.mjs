/** Read-only forecast using the same Angular analyzer as Release; never invokes semantic-release or push. */
import { analyzeCommits } from "./release-analyzer.mjs";
import { promotionHoldCap, selectPromotion } from "./promotion-policy.ts";

function compare(a, b) {
  const left = a.replace(/^v/, "").split(/[.-]/).map(Number);
  const right = b.replace(/^v/, "").split(/[.-]/).map(Number);

  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];

  return 0;
}

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
  const tags = git("tag", "--merged", plan.sha, "--list", "v*").split("\n");

  const stable = tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort(compare)
    .at(-1);

  if (!stable) return undefined; // Same bootstrap guard as semantic-release.mjs.
  const stableVersion = stable.slice(1);

  if (
    !(await analyze(
      plan.included.map((commit) => ({ message: commit.message, hash: commit.sha })),
      stableVersion,
    ))
  )
    return undefined;
  const hashes = git("rev-list", `${stable}..${plan.sha}`).split("\n").filter(Boolean);

  const bump = await analyze(
    hashes.map((sha) => ({ message: git("show", "-s", "--format=%B", sha), hash: sha })),
    stableVersion,
  );

  if (!bump) return undefined;
  const parts = stableVersion.split(".").map(Number);
  const index = bump === "major" ? 0 : bump === "minor" ? 1 : 2;
  parts[index]++;

  for (let i = index + 1; i < 3; i++) parts[i] = 0;
  let core = parts.join(".");

  if (input.path === "next-main") return core;

  const betaTags = git("tag", "--merged", input.target, "--list", "v*-beta.*")
    .split("\n")
    .filter((tag) => /^v\d+\.\d+\.\d+-beta\.\d+$/.test(tag))
    .sort((a, b) => compare(a, b) || Number(a.split(".").at(-1)) - Number(b.split(".").at(-1)));

  const previous = betaTags.at(-1);

  if (previous && compare(previous, core) > 0) core = previous.slice(1).split("-")[0];
  const counter = previous && compare(previous, core) === 0 ? Number(previous.split(".").at(-1)) + 1 : 1;

  return `${core}-beta.${counter}`;
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
