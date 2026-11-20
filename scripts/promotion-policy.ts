import { promotionLinks } from "./promotion-links.ts";
import { compareTags } from "./version.ts";

/** Cutoffs are indices in oldest-first source first-parent history outside target's ancestry. */
export interface PromotionCommit {
  sha: string;
  parent: string;
  landedAt: number;
  message: string;
  files: string[];
  attributions: PromotionAttribution[];
  prs: { number: number; body: string; hold: boolean }[];
  green: boolean;
  /** Exact recovery run selected for this SHA, independently of any promotion hold. */
  recoveryRun?: string;
  release?: { tag: string; readyAt: number };
}

export interface PromotionAttribution {
  sha: string;
  file: string;
  lines: number[];
  kind: "changed" | "adjacent";
}

export interface PromotionInput {
  path: "dev-next" | "next-main";
  target: string;
  commits: PromotionCommit[];
  now: number;
  soakMs: number;
  paused: boolean;
  blockers: number[];
  pendingFixes?: PromotionCommit[];
  activeBeta?: { tag: string; sha: string };
  nightlyFloor?: string;
  pendingRelease?: { branch: "next" | "main"; sha: string };
  releaseBlock?: string;
  publicReleaseTags?: string[];
  minimumIndex?: number;
  /** Automatic policy by default; manual Promote supplies Infinity. */
  holdCapMs?: number;
}

export interface PromotionHold {
  sha: string;
  reason: string;
  since: number;
}

export interface PromotionPlan {
  initial: string;
  sha: string;
  included: PromotionCommit[];
  holds: PromotionHold[];
  expiredHolds: PromotionHold[];
  reason: string;
  starved: boolean;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DEV_NEXT_SOAK_MS = 6 * HOUR;
export const HOLD_CAP_DAYS = 1;

export function promotionHoldCap(input: PromotionInput): number {
  return input.holdCapMs ?? HOLD_CAP_DAYS * DAY;
}

function isRevert(commit: PromotionCommit): boolean {
  return /^revert\b/i.test(commit.message) || /^This reverts commit [a-f0-9]{7,40}/im.test(commit.message);
}

/** These shared files cannot establish a relationship; explicit links still can. */
export function sharedPromotionFile(path: string): boolean {
  return (
    path.startsWith("packages/contracts/src/gen/") ||
    path.startsWith("packages/codex-protocol/src/gen/") ||
    path === "packages/db/src/migrations/index.ts" ||
    path === "packages/db/test/schema.test.ts" ||
    path.startsWith("docs/") ||
    /^(?:AGENTS|CLAUDE|README|CONTRIBUTING)\.md$/i.test(path) ||
    /(^|\/)(?:bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$/i.test(
      path,
    ) ||
    /(^|\/)(?:changelog|changes|history|release-notes)(?:[.-][^/]*)?$/i.test(path)
  );
}

/** Docs, tests, CI and chores change no shipped behaviour, so blame can't make them the change a fix corrects. */
function canIntroduceDefect(commit: PromotionCommit): boolean {
  return !/^(?:docs|test|ci|chore|style)(?:\([^\n)]+\))?!?:/i.test(commit.message);
}

export function isPromotionFollowup(commit: PromotionCommit): boolean {
  return (
    /^(?:fix|perf|revert)(?:\([^\n)]+\))?!?:|^revert\b/i.test(commit.message) ||
    /^This reverts commit [a-f0-9]{7,40}/im.test(commit.message)
  );
}

export function promotionCommitLinks(commit: PromotionCommit) {
  return promotionLinks([commit.message, ...commit.prs.map((pr) => pr.body)].join("\n"));
}

function eligibleSince(input: PromotionInput, index: number): number {
  if (input.path === "dev-next") return input.commits[index]!.landedAt + input.soakMs;
  const publications = input.commits.slice(index).flatMap((commit) => (commit.release ? [commit.release.readyAt] : []));

  return Math.min(...publications) + input.soakMs;
}

function relationship(fix: PromotionCommit, original: PromotionCommit): string | undefined {
  const links = promotionCommitLinks(fix);
  const linked = original.prs.find((pr) => links.prs.includes(pr.number));

  if (linked) return `${fix.sha}: explicit PR #${linked.number}`;
  const sha = links.shas.find((reference) => original.sha.startsWith(reference));

  if (sha) return `${fix.sha}: explicit SHA ${sha}`;

  if (links.prs.length || links.shas.length) return undefined;
  const elapsed = fix.landedAt - original.landedAt;

  if (elapsed < 0 || elapsed > 7 * DAY || !canIntroduceDefect(original)) return undefined;
  const attributed = fix.attributions.filter((item) => item.sha === original.sha && !sharedPromotionFile(item.file));

  return attributed.length
    ? `${fix.sha}: blamed lines ${attributed.map((item) => `${item.file}:${item.lines.join(",")} (${item.kind})`).join("; ")}`
    : undefined;
}

function readyIndex(input: PromotionInput, ceiling: number): number {
  // Exact-commit Release success only: a descendant's tests cannot prove this tree works without its fixes.
  for (let i = ceiling; i >= (input.minimumIndex ?? 0); i--) {
    const commit = input.commits[i]!;

    if (!commit.release) continue;

    const eligible =
      input.path === "dev-next"
        ? !input.nightlyFloor || compareTags(commit.release.tag, input.nightlyFloor) >= 0
        : isActiveBeta(input, commit);

    if (eligible && commit.green) return i;
  }

  // Without an applicable release floor, untagged dev commits may use their own green Release run.
  if (input.path === "dev-next" && !input.nightlyFloor) {
    for (let i = ceiling; i >= (input.minimumIndex ?? 0); i--) if (input.commits[i]!.green) return i;
  }

  return -1;
}

function isActiveBeta(input: PromotionInput, commit: PromotionCommit): boolean {
  return commit.sha === input.activeBeta?.sha && commit.release?.tag === input.activeBeta.tag;
}

export function selectPromotion(input: PromotionInput): PromotionPlan {
  let cutoff = -1;
  const holds: PromotionHold[] = [];
  const expiredHolds = new Map<string, PromotionHold>();

  for (const [i, commit] of input.commits.entries()) {
    const since = input.path === "dev-next" ? commit.landedAt : commit.release?.readyAt;

    // Do not skip a young commit if committer dates are out of order.
    if (input.path === "dev-next" && (since === undefined || since > input.now - input.soakMs)) break;

    if (
      since !== undefined &&
      since <= input.now - input.soakMs &&
      (input.path === "dev-next" || isActiveBeta(input, commit))
    )
      cutoff = i;
  }

  if (cutoff < (input.minimumIndex ?? 0)) cutoff = -1;
  const initial = input.commits[cutoff]?.sha ?? input.target;
  // A qualifying revert must accompany its original even if readiness or another hold shrinks the prefix.
  const qualifyingReverts = new Set(input.commits.slice(0, cutoff + 1).filter(isRevert));
  const held = input.commits.findIndex((commit) => commit.prs.some((pr) => pr.hold));

  if (held >= 0 && held <= cutoff) {
    const commit = input.commits[held]!;
    holds.push({ sha: commit.sha, reason: "promotion-hold", since: eligibleSince(input, held) });
    cutoff = held - 1;
  }

  // Readiness, holds and follow-ups can each shrink the prefix. Revisit all excluded fixes after every shrink.
  let previous: number;

  do {
    previous = cutoff;
    cutoff = readyIndex(input, cutoff);

    for (let i = 0; i <= cutoff; i++) {
      const original = input.commits[i]!;

      for (const fix of [...input.commits.slice(cutoff + 1), ...(input.pendingFixes ?? [])]) {
        if (!isPromotionFollowup(fix)) continue;
        const reason = relationship(fix, original);

        if (!reason) continue;
        const hold = { sha: original.sha, reason, since: eligibleSince(input, i) };

        if (!qualifyingReverts.has(fix) && input.now - hold.since > promotionHoldCap(input)) {
          expiredHolds.set(`${original.sha}:${fix.sha}`, hold);
          continue;
        }

        holds.push(hold);
        cutoff = i - 1;
        break;
      }
    }
  } while (cutoff !== previous);

  let reason = cutoff < 0 ? "Nothing ready to promote" : "Ready";

  if (cutoff < 0 && input.path === "next-main" && input.commits.length) {
    reason = input.activeBeta
      ? `Waiting for eligible beta ${input.activeBeta.tag}`
      : "Stable requires an active public beta";
  }

  if (input.releaseBlock) reason = input.releaseBlock;
  else if (input.paused) reason = "AUTO_PROMOTION=off";
  else if (input.blockers.length)
    reason = `Open release-blocker issues: ${input.blockers.map((n) => `#${n}`).join(", ")}`;
  const blocked = !!input.releaseBlock || input.paused || input.blockers.length > 0;

  return {
    initial,
    sha: blocked ? input.target : (input.commits[cutoff]?.sha ?? input.target),
    included: blocked ? [] : input.commits.slice(0, cutoff + 1),
    holds,
    expiredHolds: [...expiredHolds.values()],
    reason,
    starved:
      holds.some((hold) => input.now - hold.since >= 7 * DAY) ||
      (input.blockers.length > 0 && initial !== input.target && input.now - eligibleSince(input, 0) >= 7 * DAY),
  };
}
