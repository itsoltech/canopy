import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { CreateWorktreeSchema, ListGitRefsSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { Journal } from "../journal/index.ts";
import { HostState } from "../runtime/host-state.ts";
import { HostContext } from "../runtime/host-context.ts";
import { freshGit } from "./git.ts";
import { createWorktree } from "./worktrees.ts";

const temp = tempDirs();

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd, stdio: "pipe" })
    .toString()
    .trim();

function fixture(attrs: string) {
  const dir = realpathSync(temp("canopy-agent-worktree-"));
  const repo = join(dir, "repo");
  run(dir, "init", "-q", "-b", "main", repo);
  run(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "file"), "version\n");
  writeFileSync(join(repo, ".gitattributes"), attrs);
  run(repo, "add", ".");
  run(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");

  const marker = join(dir, "executed");
  const command = `echo called >> "${marker.replaceAll("\\", "/")}"`;
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);

  for (const hook of ["post-checkout", "reference-transaction", "post-index-change"])
    writeFileSync(join(hooks, hook), "#!/bin/sh\n" + command + "\n", { mode: 0o755 });

  run(repo, "config", "core.hooksPath", hooks);
  run(repo, "config", "core.fsmonitor", command);

  const request = create(CreateWorktreeSchema, {
    repoPath: repo,
    baseRef: run(repo, "rev-parse", "HEAD"),
    branch: "feature/exact",
    agentRequested: true,
  });

  const worktree = () => freshGit(() => createWorktree(join(dir, "worktrees"), request));

  return { dir, repo, marker, command, request, worktree };
}

test("agent checkout preserves the exact branch and built-in conversion without hooks or fsmonitor", async () => {
  const f = fixture("file text eol=crlf\n");
  writeFileSync(join(f.repo, "file"), "uncommitted\n");
  const tree = await f.worktree();
  expect(tree.branch).toBe(f.request.branch);
  expect(run(tree.path!, "rev-parse", "HEAD")).toBe(f.request.baseRef);
  expect(readFileSync(join(tree.path!, "file"), "utf8")).toBe("version\r\n");
  expect(readFileSync(join(f.repo, "file"), "utf8")).toBe("uncommitted\n");
  expect(run(tree.path!, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "status", "--porcelain")).toBe("");

  await expect(f.worktree()).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
  f.request.branch = "@{-1}";
  await expect(f.worktree()).rejects.toMatchObject({ code: "BAD_BRANCH" });
  f.request.startFromRemote = true;
  await expect(f.worktree()).rejects.toMatchObject({ code: "BAD_REF" });
  expect(existsSync(f.marker)).toBe(false);
});

test("destination-specific filters refuse the checkout and roll back registration and branch without invoking Git policy", async () => {
  const f = fixture("");
  const config = join(f.dir, "destination-config");
  const attrs = join(f.dir, "destination-attributes");
  writeFileSync(attrs, "file filter=custom\n");
  run(f.dir, "config", "--file", config, "core.attributesFile", attrs);
  run(f.dir, "config", "--file", config, "filter.custom.smudge", f.command);
  run(f.repo, "config", "includeIf.onbranch:feature/**.path", config);

  await expect(f.worktree()).rejects.toMatchObject({
    code: "WORKTREE_FILTER_UNSUPPORTED",
    message: "This checkout uses Git filters. Create the worktree manually.",
  });
  expect(run(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  expect(run(f.repo, "worktree", "list", "--porcelain").split("worktree ")).toHaveLength(2);
  expect(existsSync(f.marker)).toBe(false);
});

test("a missing local blob fails and rolls back without fetching it from the promisor remote", async () => {
  const f = fixture("");
  const remote = join(f.dir, "remote.git");
  run(f.dir, "clone", "--bare", "--no-local", f.repo, remote);
  run(f.repo, "remote", "add", "origin", remote);
  run(f.repo, "config", "remote.origin.promisor", "true");
  run(f.repo, "config", "remote.origin.partialclonefilter", "blob:none");
  const oid = run(f.repo, "rev-parse", "HEAD:file");
  const blob = join(f.repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  unlinkSync(blob);

  await expect(f.worktree()).rejects.toMatchObject({ code: "WORKTREE_CHECKOUT_FAILED" });
  expect(existsSync(blob)).toBe(false);
  expect(run(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  expect(existsSync(f.marker)).toBe(false);
});

test("worktree destinations exclude the private secret store while manual Git discovery can still inspect the repo", async () => {
  const f = fixture("");
  const dataDir = join(f.repo, "private");
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
  const state = new HostState({ runtime, dataDir, clientVersion: "test" });
  const { ops } = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
  const alias = join(f.dir, "alias");
  symlinkSync(state.secrets.root, alias, process.platform === "win32" ? "junction" : "dir");

  const refs = (repoPath: string, validateWorktreeDestination: boolean) =>
    ops.listGitRefs({
      case: "listGitRefs",
      value: create(ListGitRefsSchema, {
        repoPath,
        worktreesOnly: true,
        branchesOnly: true,
        validateWorktreeDestination,
      }),
    });

  try {
    await expect(refs(f.repo, true)).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    await expect(refs(alias, true)).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect((await refs(f.repo, false)).gitRefs?.repoRoot).toBe(f.repo);
    const safe = join(f.repo, "project");
    mkdirSync(safe);
    expect((await refs(safe, true)).gitRefs?.repoRoot).toBe(f.repo);
    f.request.location = join(alias, "new-location");
    await expect(
      ops.createWorktree({ case: "createWorktree", value: f.request }, crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    expect(existsSync(f.request.location)).toBe(false);
    expect(run(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  } finally {
    state.secrets.close();
    await runtime.dispose();
  }
});
