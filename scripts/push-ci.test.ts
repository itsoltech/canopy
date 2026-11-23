import type { JsonObject } from "@canopy/domain/json";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sha = "a".repeat(40);
const repo = "fixture/canopy";

const branchRun = {
  id: 42,
  event: "push",
  path: ".github/workflows/push-ci.yml",
  head_branch: "dev",
  head_sha: sha,
  head_repository: { full_name: repo },
};

const aggregate = { name: "checks / Typecheck, tests, builds", status: "completed", conclusion: "success" };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "canopy-push-ci-"));
  directories.push(cwd);
  const json = (name: string, data: JsonObject) => writeFileSync(join(cwd, name), JSON.stringify(data));

  for (const branch of ["dev", "next", "main"]) json(branch, { workflow_runs: [] });
  json("run", { status: "completed", conclusion: "success" });
  json("jobs", { jobs: [aggregate] });
  writeFileSync(join(cwd, "summary"), "");
  writeFileSync(
    join(cwd, "gh"),
    `#!/usr/bin/env bash
set -eu
[[ "$1" == api ]] || exit 1
shift
case "$*" in
  "repos/$GITHUB_REPOSITORY/actions/workflows/push-ci.yml/runs?event=push&branch="*"&head_sha=$EXPECTED_SHA&per_page=1")
    branch=\${1#*&branch=}
    cat "\${branch%%&*}" ;;
  "repos/$GITHUB_REPOSITORY/actions/runs/42") cat run ;;
  "--paginate repos/$GITHUB_REPOSITORY/actions/runs/42/jobs?filter=latest&per_page=100") cat jobs ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  const run = (branch: string, ...args: string[]) =>
    Bun.spawnSync(["bash", resolve(import.meta.dir, "../.github/scripts/verify-push-ci.sh"), ...args], {
      cwd,
      env: {
        ...process.env,
        PATH: cwd + ":" + process.env["PATH"],
        GITHUB_REPOSITORY: repo,
        GITHUB_SERVER_URL: "https://github.com",
        EXPECTED_SHA: sha,
        RELEASE_BRANCH: branch,
        GITHUB_OUTPUT: join(cwd, "output"),
        GITHUB_STEP_SUMMARY: join(cwd, "summary"),
      },
    }).exitCode;

  return { cwd, json, run };
}

test("promotion reuses the original Push CI, a new hotfix requires its own run", () => {
  const f = fixture();
  expect(f.run("next", "--find-upstream")).toBe(0);
  expect(readFileSync(join(f.cwd, "output"), "utf8")).toBe("upstream=\n");
  expect(f.run("next")).toBe(1);
  f.json("next", { workflow_runs: [{ ...branchRun, head_branch: "next" }] });
  expect(f.run("main", "--find-upstream")).toBe(0);
  expect(readFileSync(join(f.cwd, "output"), "utf8")).toEndWith("upstream=42\n");
  expect(f.run("main")).toBe(0);
  expect(f.run("dev")).toBe(1);
});

test("only the protected channel push for the pinned commit supplies release evidence", () => {
  const f = fixture();

  for (const fields of [
    { head_sha: "b".repeat(40) },
    { head_branch: "other" },
    { event: "pull_request" },
    { head_repository: { full_name: "fork/canopy" } },
    { path: ".github/workflows/other.yml" },
  ]) {
    f.json("dev", { workflow_runs: [{ ...branchRun, ...fields }] });
    expect(f.run("dev")).toBe(1);
  }
});

test("both the latest workflow and its aggregate must have completed successfully", () => {
  const f = fixture();
  f.json("dev", { workflow_runs: [branchRun] });

  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
    f.json("run", { status: "completed", conclusion });
    expect(f.run("dev")).toBe(1);
  }

  f.json("run", { status: "completed", conclusion: "success" });

  for (const jobs of [[], [{ ...aggregate, conclusion: "skipped" }], [{ ...aggregate, status: "in_progress" }]]) {
    f.json("jobs", { jobs });
    expect(f.run("dev")).toBe(1);
  }

  expect(readFileSync(join(f.cwd, "summary"), "utf8")).toBe("");
  f.json("jobs", { jobs: [aggregate] });
  expect(f.run("dev")).toBe(0);
  expect(readFileSync(join(f.cwd, "summary"), "utf8")).toContain(sha);
});

test("a release waits for a running push and observes its final conclusion", () => {
  const f = fixture();
  f.json("dev", { workflow_runs: [branchRun] });
  writeFileSync(join(f.cwd, "sleep"), "#!/bin/sh\nmv completed run\n", { mode: 0o755 });

  for (const [conclusion, exitCode] of [
    ["failure", 1],
    ["success", 0],
  ] as const) {
    f.json("run", { status: "in_progress", conclusion: null });
    f.json("completed", { status: "completed", conclusion });
    expect(f.run("dev")).toBe(exitCode);
  }
});
