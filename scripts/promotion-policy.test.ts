import { expect, test } from "bun:test";
import {
  DAY,
  selectPromotion,
  sharedPromotionFile,
  type PromotionCommit,
  type PromotionInput,
} from "./promotion-policy.ts";
import { promotionLinks } from "./promotion-links.ts";

const now = 20_000 * DAY;
const target = "0".repeat(40);

function commit(
  id: number,
  ageHours: number,
  message = "feat: feature",
  files = ["apps/worker/src/run.ts"],
): PromotionCommit {
  return {
    sha: id.toString(16).padStart(40, "a"),
    parent: target,
    landedAt: now - ageHours * 3_600_000,
    message,
    files,
    attributions: files.map((file) => ({
      sha: (id - 1).toString(16).padStart(40, "a"),
      file,
      lines: [1],
      kind: "changed",
    })),
    prs: [{ number: id, body: "", hold: false }],
    green: true,
    release: { tag: `v0.2.0-nightly.${id}`, readyAt: now - ageHours * 3_600_000 },
  };
}

function input(commits: PromotionCommit[]): PromotionInput {
  return { path: "dev-next", target, commits, now, soakMs: DAY, paused: false, blockers: [] };
}

test("soak picks an ancestor; feature and its one-hour-later fix wait until both have soaked", () => {
  const feature = commit(68, 24.5);
  const fix = commit(69, 23.5, "fix: repair feature");
  const data = input([feature, fix]);
  const held = selectPromotion(data);
  expect(held.initial).toBe(feature.sha);
  expect(held.sha).toBe(target);
  expect(held.holds[0]?.reason).toContain(fix.sha);
  expect(selectPromotion({ ...data, now: now + 0.5 * 3_600_000 }).sha).toBe(fix.sha);
  expect(selectPromotion(input([commit(1, 48), commit(2, 3, "feat: newer", ["other.ts"])])).sha).toBe(
    commit(1, 48).sha,
  );
});

test("explicit footers link across files and beyond the seven-day file lookback", () => {
  for (const body of ["Fixes: #68", "Refs #68", "follow-up to #68", `Refs: ${commit(68, 240).sha.slice(0, 10)}`]) {
    const feature = commit(68, 240, "feat: original", ["a.ts"]);
    const fix = commit(69, 1, "fix: follow-up", ["b.ts"]);
    fix.prs[0]!.body = body;
    expect(selectPromotion(input([feature, fix])).sha).toBe(target);
  }

  expect(selectPromotion(input([commit(68, 240), commit(69, 1, "fix: unrelated same file after 7 days")])).sha).toBe(
    commit(68, 240).sha,
  );
});

test("documented links and GitHub closing keywords parse; incidental mentions and malformed footers do not", () => {
  for (const keyword of [
    "Fixes:",
    "Refs:",
    "Refs",
    "follow-up to",
    "Fixes an earlier change:",
    "fix",
    "fixes",
    "fixed",
    "close",
    "closes",
    "closed",
    "resolve",
    "resolves",
    "resolved",
  ]) {
    expect(promotionLinks(`fix: repair\n\n${keyword} #68`).prs).toEqual([68]);
  }

  const sha = "abc1234567890";
  expect(promotionLinks(`Refs: ${sha}\nThis reverts commit ${sha}.`).shas).toEqual([sha, sha]);

  for (const text of [
    "see #68 in logs",
    "fix: discussion #68",
    "#68",
    "Refs: #68junk",
    "Fixes: abc1234567890",
    "Refs abc1234567890",
    "follow-up to: #68",
    "Refs:\n#68",
    "Refs: abc12",
    "Contains abc1234567890",
    "Refs: #68 and unrelated work",
  ]) {
    expect(promotionLinks(text)).toEqual({ prs: [], shas: [] });
  }
});

test("an explicit original takes precedence over incidental line attribution to another change", () => {
  const unrelated = commit(1, 50);
  const original = commit(2, 40);
  const fix = commit(3, 1, "fix: repair\n\nRefs: #2");
  fix.attributions = [{ sha: unrelated.sha, file: "apps/worker/src/run.ts", lines: [1], kind: "changed" }];
  expect(selectPromotion(input([unrelated, original, fix])).sha).toBe(unrelated.sha);
});

test("stable also waits for known dev fixes that have not reached beta yet", () => {
  const beta = commit(1, 200);
  beta.release = { tag: "v0.2.0-beta.1", readyAt: now - 100 * 3_600_000 };
  const fix = commit(2, 1, "fix: beta defect\n\nFixes: #1");
  const data: PromotionInput = { ...input([beta]), path: "next-main", soakMs: 3 * DAY, pendingFixes: [fix] };
  expect(selectPromotion(data).sha).toBe(target);
});

test("shared/generated paths cannot hold by blame; migrations and application code still can", () => {
  const shared = [
    "packages/contracts/src/gen/canopy/worker/v1/link_pb.ts",
    "packages/codex-protocol/src/gen/v2.ts",
    "packages/db/src/migrations/index.ts",
    "packages/db/test/schema.test.ts",
    "bun.lock",
    "bun.lockb",
    "docs/release.md",
    "package-lock.json",
    "apps/web/pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "npm-shrinkwrap.json",
    "Gemfile.lock",
    "poetry.lock",
    "uv.lock",
    "CHANGELOG.md",
    "apps/web/changes.txt",
    "HISTORY",
    "release-notes.md",
  ];

  for (const path of shared) {
    expect(sharedPromotionFile(path)).toBe(true);
    expect(
      selectPromotion(input([commit(1, 30, "feat: original", [path]), commit(2, 1, "fix: generated", [path])])).sha,
    ).toBe(commit(1, 30).sha);
  }

  for (const path of [
    "packages/db/src/migrations/0043_feature.sql",
    "proto/canopy/worker/v1/link.proto",
    "apps/web/src/lib/feature.ts",
  ]) {
    expect(
      selectPromotion(input([commit(1, 30, "feat: original", [path]), commit(2, 1, "perf: correction", [path])])).sha,
    ).toBe(target);
  }

  const fix = commit(2, 1, "fix: generated\n\nFixes: #1", ["bun.lock"]);
  expect(selectPromotion(input([commit(1, 30, "feat: original", ["bun.lock"]), fix])).sha).toBe(target);
});

test("a revert holds its original SHA even without overlapping files", () => {
  const original = commit(1, 30);
  const revert = commit(2, 1, `revert: feature\n\nThis reverts commit ${original.sha}.`, []);
  expect(selectPromotion(input([original, revert])).sha).toBe(target);
});

test("fixpoint handles chains, readiness fallback, and promotion-hold without splitting old fixes", () => {
  const feature = commit(1, 100, "feat: original", ["a.ts"]);
  const fix1 = commit(2, 70, "fix: follow-up\n\nRefs: #1", ["b.ts"]);
  const fix2 = commit(3, 1, "fix: follow-up\n\nFixes: #2", ["c.ts"]);
  expect(selectPromotion(input([feature, fix1, fix2])).sha).toBe(target);
  const heldFix = { ...fix1, prs: [{ number: 2, body: "", hold: true }] };
  expect(selectPromotion(input([feature, heldFix])).sha).toBe(target);
  expect(selectPromotion(input([feature, { ...fix1, green: false }])).sha).toBe(target);
  const untaggedFix = { ...fix1 };
  delete untaggedFix.release;
  expect(selectPromotion(input([{ ...feature, green: false }, untaggedFix])).sha).toBe(fix1.sha);
});

test("pause and release-blocker prevent advancement; eligible waiting for seven days raises starvation", () => {
  const feature = commit(1, 240);
  const fix = commit(2, 1, "fix: follow-up\n\nRefs: #1");
  expect(selectPromotion({ ...input([feature]), paused: true }).reason).toBe("AUTO_PROMOTION=off");
  expect(selectPromotion({ ...input([feature]), blockers: [7] }).sha).toBe(target);
  expect(selectPromotion(input([feature, fix])).starved).toBe(true);
  expect(selectPromotion(input([commit(1, 30), fix])).starved).toBe(false);
});

test("stable only picks beta-tagged commits with manifests aged 72 hours; a newer beta does not reset an older one", () => {
  const old = commit(1, 200);
  old.release = { tag: "v0.2.0-beta.1", readyAt: now - 73 * 3_600_000 };
  const young = commit(2, 190, "feat: newer", ["other.ts"]);
  young.release = { tag: "v0.2.0-beta.2", readyAt: now - DAY };
  const data = { ...input([old, young]), path: "next-main" as const, soakMs: 3 * DAY };
  expect(selectPromotion(data).sha).toBe(old.sha);
  expect(selectPromotion({ ...data, now: now + 2 * DAY }).sha).toBe(young.sha);
  expect(selectPromotion({ ...data, commits: [young] }).sha).toBe(target);
});

test("empty histories, young commits and failed latest CI are no-ops; tags are preferred", () => {
  expect(selectPromotion(input([])).sha).toBe(target);
  expect(selectPromotion(input([commit(1, 1)])).sha).toBe(target);
  expect(selectPromotion(input([{ ...commit(1, 48), green: false }])).sha).toBe(target);
  const old = commit(1, 48);
  const untagged = commit(2, 30, "docs: describe", []);
  delete untagged.release;
  expect(selectPromotion(input([old, untagged])).sha).toBe(old.sha);
});
