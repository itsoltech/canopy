import { gt, inc, lt, rcompare, valid } from "semver";

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d+$/;
const BETA_TAG = /^v\d+\.\d+\.\d+-beta\.\d+$/;

const core = (tag) => tag.slice(1).split("-")[0];

function latestTag(tags, predicate) {
  return tags.filter((tag) => predicate(tag) && valid(tag)).sort(rcompare)[0];
}

export function publishedReleaseTags(releases) {
  return releases.flatMap((release) => {
    const tag = release?.tag_name;

    if (release?.draft !== false || !valid(tag)) return [];

    if (release.prerelease === false && STABLE_TAG.test(tag)) return [tag];

    return release.prerelease === true && (NIGHTLY_TAG.test(tag) || BETA_TAG.test(tag)) ? [tag] : [];
  });
}

export function latestStableTag(tags) {
  return latestTag(tags, (tag) => STABLE_TAG.test(tag));
}

export function latestBetaTag(tags) {
  return latestTag(tags, (tag) => BETA_TAG.test(tag));
}

export function firstNightlyAfterRelease(tags) {
  const bases = [latestStableTag(tags), latestBetaTag(tags)].flatMap((tag) => (tag ? [core(tag)] : [])).sort(rcompare);

  return bases.length ? `${inc(bases[0], "minor")}-nightly.1` : undefined;
}

export function nightlyBaseTag(reachableTags, publicTags, isAncestor) {
  const published = new Set(publicTags);
  const tags = reachableTags.filter((tag) => published.has(tag));
  const floor = firstNightlyAfterRelease(publicTags);
  const nightly = latestTag(tags, (tag) => NIGHTLY_TAG.test(tag));
  let base = nightly && (!floor || !lt(nightly, floor)) ? nightly : undefined;

  // A Nightly published while Beta was building can be ahead of the promoted SHA.
  // Once that series closes, retest changes since the promoted SHA on the new series.
  for (const promoted of [latestBetaTag(tags), latestStableTag(tags)]) {
    if (promoted && (!base || isAncestor(base, promoted))) base = promoted;
  }

  return base ?? nightly;
}

export function closedBetaCores(tags, publicTags, mainHeadTags) {
  const published = new Set(publicTags);

  return new Set(
    [
      ...tags.filter((tag) => STABLE_TAG.test(tag) && valid(tag)),
      ...mainHeadTags.filter((tag) => BETA_TAG.test(tag) && published.has(tag)),
    ].map(core),
  );
}

export function stableVersionForBeta(publicTags, exactTags) {
  const exact = new Set(exactTags);
  const beta = latestBetaTag(publicTags.filter((tag) => exact.has(tag)));

  if (!beta) return undefined;
  const version = core(beta);
  const latest = latestBetaTag(publicTags.filter((tag) => tag.startsWith(`v${version}-beta.`)));
  const stable = latestStableTag(publicTags);

  return beta === latest && (!stable || gt(version, stable)) ? version : undefined;
}

export function nextBetaVersion(analyzedVersion, reachableTags, publicTags, closed) {
  const previous = latestBetaTag(reachableTags);
  const stable = latestStableTag(publicTags);
  const published = new Set(publicTags);
  const nightly = latestTag(reachableTags, (tag) => NIGHTLY_TAG.test(tag) && published.has(tag));
  const previousCore = previous && core(previous);

  if (previousCore && (!stable || !lt(previousCore, stable))) {
    if (!closed.has(previousCore)) return inc(previous, "prerelease");

    if (!nightly || !gt(core(nightly), previousCore)) {
      let patch = inc(previousCore, "patch");

      while (closed.has(patch)) patch = inc(patch, "patch");

      return `${patch}-beta.1`;
    }
  }

  const promoted = nightly && `${core(nightly)}-beta.1`;

  return promoted && gt(promoted, analyzedVersion) ? promoted : analyzedVersion;
}

export function releaseVersionPolicy({ branch, publicTags, gitTags, reachableTags, exactTags, mainHeadTags, baseTag }) {
  const floor = firstNightlyAfterRelease(publicTags);
  const stableVersion = branch === "main" ? stableVersionForBeta(publicTags, exactTags) : undefined;
  const closed = branch === "next" ? closedBetaCores(gitTags, publicTags, mainHeadTags) : new Set();
  const published = new Set(publicTags);
  const keepNightly = (version) => !floor || !lt(version, floor);

  function keepReservation(tag) {
    if (branch === "dev") return keepNightly(tag.slice(1));

    if (branch === "next") return published.has(tag) || !closed.has(core(tag));

    return published.has(tag) || tag.slice(1) === stableVersion;
  }

  return {
    stableVersion,
    keepReservation,
    options: {
      // Public releases below the floor still delimit the commits eligible for Nightly.
      prereleaseBaseTag: baseTag,
      filterReleaseTags: ({ tags }) =>
        tags.filter(({ gitTag }) => {
          if (branch === "dev") {
            if (NIGHTLY_TAG.test(gitTag)) return gitTag === baseTag || keepReservation(gitTag);

            return gitTag === baseTag || (!baseTag && STABLE_TAG.test(gitTag));
          }

          return branch !== "next" || !BETA_TAG.test(gitTag) || keepReservation(gitTag);
        }),
      adjustReleaseVersion(version) {
        if (branch === "dev") return keepNightly(version) ? version : floor;

        if (branch === "next") return nextBetaVersion(version, reachableTags, publicTags, closed);

        return stableVersion;
      },
    },
  };
}
