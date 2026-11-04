/** Local git history exercises diff/blame semantics, then the actual cutoff policy consumes that evidence. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attributePromotionFix } from "./promotion-attribution.ts";
import { DAY, selectPromotion, type PromotionCommit, type PromotionInput } from "./promotion-policy.ts";

const now = Date.parse("2026-11-10T12:00:00Z");
const dirs: string[] = [];
const root = "/* stable baseline */\n";
const oldRule = ".old-pane { color: gray; padding: 12px; transition: opacity 150ms ease; }\n";
const featureRule = ".feature-pane { color: red; padding: 24px; transition: transform 300ms ease; }\n";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "canopy-promotion-blame-"));
  dirs.push(cwd);

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("init", "--initial-branch=dev");
  git("config", "user.name", "Promotion attribution fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgSign", "false");
  const commits: PromotionCommit[] = [];

  function commit(message: string, ageHours: number, contents: string, file = "motion.css") {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), contents);
    git("add", "--all");
    const date = new Date(now - ageHours * 3_600_000).toISOString();
    const parent = commits.at(-1)?.sha ?? "";
    execFileSync("git", ["commit", "-m", message], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: "pipe",
    });
    const sha = git("rev-parse", "HEAD");

    const result: PromotionCommit = {
      sha,
      parent,
      landedAt: Date.parse(date),
      message,
      files: [file],
      attributions: [],
      prs: [],
      green: true,
      release: { tag: `v0.2.0-nightly.${commits.length + 1}`, readyAt: Date.parse(date) },
    };

    if (parent) result.attributions = attributePromotionFix(result, git);
    commits.push(result);

    return result;
  }

  const baseline = commit("chore: stable baseline", 500, root);

  function input(): PromotionInput {
    return {
      path: "dev-next",
      target: baseline.sha,
      commits: commits.slice(1),
      now,
      soakMs: DAY,
      paused: false,
      blockers: [],
    };
  }

  return { git, commit, input, baseline, cwd };
}

test("a hot shared UI file holds only the feature owning the modified lines, not its earliest contributor", () => {
  const f = fixture();
  const old = f.commit("feat: older panel", 60, root + oldRule);
  const feature = f.commit("feat: new panel", 50, root + oldRule + featureRule);
  const fix = f.commit("fix: new panel color", 1, root + oldRule + featureRule.replace("red", "blue"));
  expect(fix.attributions).toEqual([{ sha: feature.sha, file: "motion.css", lines: [3], kind: "changed" }]);
  expect(selectPromotion(f.input()).sha).toBe(old.sha);
  expect(selectPromotion(f.input()).holds[0]?.reason).toContain("motion.css:3 (changed)");
  expect(selectPromotion({ ...f.input(), now: now + DAY }).sha).toBe(fix.sha);
});

test("an addition between a feature's own lines holds that feature; disagreement between neighbors is ambiguous", () => {
  const f = fixture();
  const old = f.commit("feat: old panel", 60, root + oldRule);
  const secondRule = featureRule.replace("feature-pane", "feature-title");
  const feature = f.commit("feat: panel and title", 50, root + oldRule + featureRule + secondRule);
  const contents = root + oldRule + featureRule + ".feature-extra { display: block; }\n" + secondRule;
  const fix = f.commit("fix: add a missing rule", 1, contents);
  expect(fix.attributions).toEqual([{ sha: feature.sha, file: "motion.css", lines: [3, 4], kind: "adjacent" }]);
  expect(selectPromotion(f.input()).sha).toBe(old.sha);

  const ambiguous = fixture();
  ambiguous.commit("feat: old panel", 60, root + oldRule);
  const current = ambiguous.commit("feat: new panel", 50, root + oldRule + featureRule);

  const addition = ambiguous.commit(
    "fix: ambiguous addition",
    1,
    root + oldRule + ".unknown { display: block; }\n" + featureRule,
  );

  expect(addition.attributions).toEqual([]);
  expect(selectPromotion(ambiguous.input()).sha).toBe(current.sha);
});

test("insertions at file boundaries use the one existing neighbor, while new/empty files have no context", () => {
  for (const boundary of ["start", "end"]) {
    const f = fixture();
    const feature = f.commit("feat: replace the panel", 50, featureRule);
    const extra = ".feature-extra { display: block; }\n";
    const fix = f.commit("fix: add boundary rule", 1, boundary === "start" ? extra + featureRule : featureRule + extra);
    expect(fix.attributions[0]?.sha).toBe(feature.sha);
    expect(selectPromotion(f.input()).sha).toBe(f.baseline.sha);
  }

  const f = fixture();
  f.commit("feat: empty stylesheet", 50, "", "empty.css");
  expect(f.commit("fix: fill empty file", 1, featureRule, "empty.css").attributions).toEqual([]);
  expect(f.commit("fix: new file", 0.5, featureRule, "new.css").attributions).toEqual([]);
});

test("whitespace-only edits and blank-line insertions do not hold a feature", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 50, root + featureRule);

  const fix = f.commit(
    "fix: whitespace",
    1,
    "\n" + root + featureRule.replace("color: red", "color:    red").replace(".feature-pane", "  .feature-pane") + "\n",
  );

  expect(fix.attributions).toEqual([]);
  expect(selectPromotion(f.input()).sha).toBe(feature.sha);
});

test("whitespace and rename/move history preserve the real line owner instead of the refactor commit", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 60, root + featureRule);
  f.git("mv", "motion.css", "renamed.css");
  const refactor = f.commit("chore: move and format stylesheet", 50, root + "   " + featureRule, "renamed.css");
  const fix = f.commit("fix: panel color", 1, root + "   " + featureRule.replace("red", "blue"), "renamed.css");
  expect(fix.attributions[0]?.sha).toBe(feature.sha);
  expect(fix.attributions.some((item) => item.sha === refactor.sha)).toBe(false);
  expect(selectPromotion(f.input()).sha).toBe(f.baseline.sha);
});

test("deletions attribute their preimage; released owners and owners older than seven days cannot hold", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 50, root + featureRule);
  const removal = f.commit("fix: remove the panel", 1, root);
  expect(removal.attributions[0]?.sha).toBe(feature.sha);
  expect(selectPromotion(f.input()).sha).toBe(f.baseline.sha);

  const released = fixture();
  const unrelated = released.commit("feat: panel", 50, root + featureRule);
  const fix = released.commit("fix: baseline comment", 1, root.replace("stable", "corrected") + featureRule);
  expect(fix.attributions[0]?.sha).toBe(released.baseline.sha);
  expect(selectPromotion(released.input()).sha).toBe(unrelated.sha);

  const ancient = fixture();
  const old = ancient.commit("feat: old panel", 200, root + featureRule);
  const lateFix = ancient.commit("fix: old panel", 1, root + featureRule.replace("red", "blue"));
  expect(lateFix.attributions[0]?.sha).toBe(old.sha);
  expect(selectPromotion(ancient.input()).sha).toBe(old.sha);
});

test("blame follows a feature's lines moved into a different file by a later refactor", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 60, root + featureRule);
  writeFileSync(join(f.cwd, "motion.css"), root);
  const refactor = f.commit("chore: extract panel stylesheet", 50, root + featureRule, "panel.css");
  const fix = f.commit("fix: panel color", 1, root + featureRule.replace("red", "blue"), "panel.css");
  expect(fix.attributions[0]?.sha).toBe(feature.sha);
  expect(fix.attributions.some((item) => item.sha === refactor.sha)).toBe(false);
  expect(selectPromotion(f.input()).sha).toBe(f.baseline.sha);
});

test("the versioned blame ignore list skips formatting that reflows lines", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 60, root + featureRule);
  const formatted = root + ".feature-pane {\n  color: red;\n  padding: 24px;\n  transition: transform 300ms ease;\n}\n";
  const formatter = f.commit("chore: reflow stylesheet", 50, formatted);
  writeFileSync(join(f.cwd, ".git-blame-ignore-revs"), `# Formatting only\n${formatter.sha}\n`);
  f.commit("chore: record formatting-only revision", 40, formatted);
  const fix = f.commit("fix: panel color", 1, formatted.replace("red", "blue"));
  expect(fix.attributions[0]?.sha).toBe(feature.sha);
  expect(selectPromotion(f.input()).sha).toBe(f.baseline.sha);
});

test("blame ignores listed revisions that are missing from the repository", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 60, root + featureRule);
  writeFileSync(join(f.cwd, ".git-blame-ignore-revs"), `# Pre-squash formatting\n${"0".repeat(39)}1\n`);
  f.commit("chore: list a revision that was never fetched", 40, root + featureRule);
  const fix = f.commit("fix: panel color", 1, root + featureRule.replace("red", "blue"));
  expect(fix.attributions[0]?.sha).toBe(feature.sha);
});

test("explicit PR/SHA links and standard reverts take precedence over blame and its path exclusions", () => {
  const f = fixture();
  const feature = f.commit("feat: panel", 50, root + featureRule);
  const revert = f.commit(`revert: panel\n\nThis reverts commit ${feature.sha}.`, 1, root);
  expect(revert.attributions).toEqual([]);
  expect(selectPromotion(f.input()).sha).toBe(f.baseline.sha);

  const linked: PromotionCommit = {
    ...revert,
    message: "fix: panel",
    prs: [{ number: 7, body: "Refs: #6", hold: false }],
  };

  expect(
    attributePromotionFix(linked, () => {
      throw new Error("Explicit links must not invoke blame");
    }),
  ).toEqual([]);
});

test("shared/generated exclusions still apply, and file names are literal even with spaces or brackets", () => {
  for (const file of ["docs/release.md", "bun.lock", "packages/contracts/src/gen/test.ts"]) {
    const f = fixture();
    const feature = f.commit("feat: shared file", 50, featureRule, file);
    const fix = f.commit("fix: shared file", 1, featureRule.replace("red", "blue"), file);
    expect(fix.attributions).toEqual([]);
    expect(selectPromotion(f.input()).sha).toBe(feature.sha);
  }

  const f = fixture();
  const file = "shared [ui] styles.css";
  const feature = f.commit("feat: literal file", 50, featureRule, file);
  expect(f.commit("fix: literal file", 1, featureRule.replace("red", "blue"), file).attributions[0]?.sha).toBe(
    feature.sha,
  );
});
