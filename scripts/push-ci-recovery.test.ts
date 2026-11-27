import type { JsonValue } from "@canopy/domain/json";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = "fixture/canopy";
const run = { id: 7, path: ".github/workflows/push-ci.yml", event: "push", run_attempt: 1 };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const job = (id: number, name: string, conclusion = "failure") => ({
  id,
  name,
  conclusion,
  html_url: `https://github.com/${repo}/actions/runs/7/job/${id}`,
});

type Job = ReturnType<typeof job>;

type RunChange = { run_attempt?: number; status?: string; conclusion?: string | null };

const aggregate = job(1, "checks / Typecheck, tests, builds");

// Serves the GitHub API from JSON files, applies `--jq` with the real jq and records every write.
const fakeGh = `#!/usr/bin/env bash
set -eu
[[ "$1" == api ]] || exit 1
shift
method=GET path= filter=. fields=()
while (( $# )); do
  case "$1" in
    --method) method=$2; shift ;;
    --jq) filter=$2; shift ;;
    -f|-F) fields+=("$2"); shift ;;
    --paginate) ;;
    *) path=$1 ;;
  esac
  shift
done
r="repos/$GITHUB_REPOSITORY"
case "$method $path" in
  "GET $r/actions/runs/7/attempts/1/jobs?per_page=100") jq -r "$filter" jobs ;;
  "GET $r/actions/runs/7") jq -r "$filter" run ;;
  "GET $r/actions/jobs/"*"/logs") id=\${path#"$r/actions/jobs/"}; cat "log-\${id%/logs}" ;;
  "GET $r/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100") jq -r "$filter" issues ;;
  "POST $r/actions/runs/7/rerun-failed-jobs") touch rerun ;;
  "POST $r/issues") printf '%s\\n' "\${fields[@]}" > created; jq -n -r "{number: 99} | $filter" ;;
  "POST $r/issues/"*"/comments") cp "\${fields[0]#body=@}" "comment-\${path//[^0-9]/}" ;;
  *) echo "unexpected $method $path" >&2; exit 1 ;;
esac
`;

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "canopy-push-ci-recovery-"));
  directories.push(cwd);
  const json = (name: string, data: JsonValue) => writeFileSync(join(cwd, name), JSON.stringify(data));
  const file = (name: string) => join(cwd, name);

  json("run", { ...run, status: "completed", conclusion: "failure" });
  json("issues", []);
  writeFileSync(file("gh"), fakeGh, { mode: 0o755 });

  const script = (mode: "rerun" | "report") =>
    Bun.spawnSync(["bash", resolve(import.meta.dir, "../.github/scripts/push-ci-recovery.sh"), mode], {
      cwd,
      env: {
        ...process.env,
        PATH: cwd + ":" + process.env["PATH"],
        GITHUB_REPOSITORY: repo,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_STEP_SUMMARY: file("summary"),
        RUN_ID: "7",
        HEAD_SHA: "a".repeat(40),
        HEAD_BRANCH: "dev",
      },
    }).exitCode;

  return { json, file, script };
}

test("only a first attempt whose failures are all test jobs is retried, and only once", () => {
  const f = fixture();

  const retried = (jobs: Job[], current: RunChange = {}) => {
    rmSync(f.file("rerun"), { force: true });
    f.json("jobs", { jobs: [aggregate, ...jobs] });
    f.json("run", { ...run, status: "completed", conclusion: "failure", ...current });
    expect(f.script("rerun")).toBe(0);

    return existsSync(f.file("rerun"));
  };

  expect(retried([job(2, "checks / Tests (3/12)"), job(3, "checks / push-native / Native checks (darwin-x64)")])).toBe(
    true,
  );
  expect(retried([job(2, "checks / Tests (3/12)", "timed_out")])).toBe(true);
  expect(retried([job(2, "checks / binary-smoke / Standalone (linux-x64)")])).toBe(true);
  // A deterministic check, a cancelled job or a run already retried keeps the failure for a person to read.
  expect(retried([job(2, "checks / Tests (3/12)"), job(3, "checks / Static checks")])).toBe(false);
  expect(retried([job(2, "checks / Web and Linux binaries")])).toBe(false);
  expect(retried([job(2, "checks / Tests (3/12)", "cancelled")])).toBe(false);
  expect(retried([])).toBe(false);
  expect(retried([job(2, "checks / Tests (3/12)")], { run_attempt: 2 })).toBe(false);
  expect(retried([job(2, "checks / Tests (3/12)")], { status: "in_progress", conclusion: null })).toBe(false);
});

test("a passing retry reports each failed test once on a single open issue", () => {
  const f = fixture();
  f.json("jobs", { jobs: [aggregate, job(2, "checks / Tests (3/12)"), job(3, "checks / Tests (8/12)")] });
  writeFileSync(
    f.file("log-2"),
    [
      "2026-11-27T11:52:35.1Z (pass) unrelated [2.00ms]",
      "2026-11-27T11:52:35.2Z (fail) mirrors > keeps the `cursor` intact [98.23ms]\r",
      "2026-11-27T11:52:35.3Z (fail) storage > preflights [15000.02ms]",
      "2026-11-27T11:52:36.0Z (fail) mirrors > keeps the `cursor` intact [98.23ms]",
    ].join("\n"),
  );
  writeFileSync(f.file("log-3"), "2026-11-27T11:52:35.2Z error: postgres exited\n");

  expect(f.script("report")).toBe(0);
  expect(readFileSync(f.file("created"), "utf8")).toStartWith("title=Flaky tests in Push CI\n");
  const comment = readFileSync(f.file("comment-99"), "utf8");
  expect(comment).toContain(`/actions/runs/7/attempts/1`);
  expect(comment.split("\n").filter((line) => line.startsWith("  - "))).toEqual([
    "  - `mirrors > keeps the 'cursor' intact`",
    "  - `storage > preflights`",
    "  - No failed test in the log. The job itself failed.",
  ]);
  expect(comment).toContain(`- [checks / Tests (8/12)](https://github.com/${repo}/actions/runs/7/job/3), failure`);

  // The next flaky run comments on the open issue instead of opening another one.
  rmSync(f.file("created"));
  f.json("issues", [
    { number: 41, title: "Flaky tests in Push CI" },
    { number: 40, title: "Other" },
  ]);
  expect(f.script("report")).toBe(0);
  expect(existsSync(f.file("created"))).toBe(false);
  expect(readFileSync(f.file("comment-41"), "utf8")).toBe(comment);
});
