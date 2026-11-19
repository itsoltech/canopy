import { afterEach, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { create } from "@bufbuild/protobuf";
import { RemoveWorktreeSchema } from "@canopy/contracts";
import { cleanupRemovedBranch, recoverRemoval, removeWorktree } from "./remove-worktree.ts";
import { deleteArchivedBranch } from "./delete-archived-branch.ts";
import { deleteUnusedBranch } from "./branch-checkout-guards.ts";

const roots: string[] = [];

function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd: repo });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function fixture() {
  const root = tempDir("canopy-branch-cleanup-");
  roots.push(root);
  const repo = join(root, "repo");
  git(root, "init", "-qb", "main", repo);
  writeFileSync(join(repo, "file"), "first\nsecond\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "switch", "-qc", "topic");

  return { root, repo };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = { remote: "origin", baseRef: "main" };

test("retains a deletion-only patch until the base actually contains the squash", async () => {
  const { repo } = fixture();
  writeFileSync(join(repo, "file"), "first\n");
  git(repo, "commit", "-qam", "remove second line");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "independent");
  expect(await deleteArchivedBranch(repo, "topic", head, context)).toBe("retry");
  git(repo, "merge", "--squash", "topic");
  git(repo, "commit", "-qm", "squashed");
  git(repo, "pack-refs", "--all");
  expect(await deleteArchivedBranch(repo, "topic", head, context)).toBe("deleted");
  expect(git(repo, "branch", "--list", "topic")).toBe("");
});

test("protects base names, release families, the live remote default and changed tips", async () => {
  const { root, repo } = fixture();
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "main");
  git(repo, "branch", "release-1.2");
  expect(await deleteArchivedBranch(repo, "release-1.2", head, context)).toBe("keep");
  expect(await deleteArchivedBranch(repo, "topic", head, { ...context, baseRef: "refs/remotes/origin/topic" })).toBe(
    "keep",
  );
  expect(await deleteArchivedBranch(repo, "topic", "1".repeat(40), context)).toBe("keep");
  const remote = join(root, "remote");
  git(root, "init", "-q", "--bare", "-b", "topic", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main", "topic");
  git(repo, "remote", "set-head", "origin", "main");
  expect(await deleteArchivedBranch(repo, "topic", head, context)).toBe("keep");
  expect(git(repo, "rev-parse", "topic")).toBe(head);
});

test("locks the main and linked HEAD during deletion while preserving unrelated refs and reflogs", async () => {
  const { repo, root } = fixture();
  git(repo, "switch", "-q", "main");
  const linked = join(root, "other checkout");
  git(repo, "worktree", "add", "-qb", "other", linked);
  const linkedLog = git(linked, "rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD");
  const log = readFileSync(linkedLog);
  const head = git(repo, "rev-parse", "topic");
  let refused = false;

  const deleted = await deleteUnusedBranch(linked, "refs/heads/topic", head, () => {
    const result = Bun.spawnSync(["git", "-c", "core.filesRefLockTimeout=0", "switch", "topic"], { cwd: linked });
    refused = result.exitCode !== 0 && result.stderr.toString().includes("HEAD.lock");

    return true;
  });

  expect(refused).toBe(true);
  expect(deleted).toBe(true);
  expect(git(linked, "symbolic-ref", "HEAD")).toBe("refs/heads/other");
  expect(readFileSync(linkedLog)).toEqual(log);
});

test("an expired authorization or a concurrently moved tip cannot delete the branch", async () => {
  const { repo } = fixture();
  git(repo, "switch", "-q", "main");
  const head = git(repo, "rev-parse", "topic");
  const moved = git(repo, "commit-tree", "-p", head, "-m", "new work", "HEAD^{tree}");
  expect(await deleteUnusedBranch(repo, "refs/heads/topic", head, () => false)).toBe(false);
  expect(
    await deleteUnusedBranch(repo, "refs/heads/topic", head, () => {
      git(repo, "update-ref", "refs/heads/topic", moved, head);

      return true;
    }),
  ).toBe(false);
  expect(git(repo, "rev-parse", "topic")).toBe(moved);
});

async function cleanCandidate() {
  const { root, repo } = fixture();
  git(repo, "switch", "-q", "main");
  const path = join(root, "linked");
  git(repo, "worktree", "add", "-q", path, "topic");
  const head = git(path, "rev-parse", "HEAD");

  const request = create(RemoveWorktreeSchema, {
    target: { id: "worktree", path, repoRoot: repo, branch: "topic", baseRef: "main", baseCommit: head },
    expectedHeadCommit: head,
    trackBranchForCleanup: true,
  });

  const receipt = join(root, "receipt");
  const output = await removeWorktree([root], request, async () => {}, receipt);

  return { root, repo, request, head, receipt, output, target: request.target! };
}

test("a clean removal receipt limits deferred cleanup to the original repository and target", async () => {
  const { root, repo, request, head, receipt, output, target } = await cleanCandidate();
  expect(output).toEqual({ worktreeBranchCleanupCandidate: true, worktreeBranchDeleted: false });
  expect(await recoverRemoval(receipt, { ...request, trackBranchForCleanup: false })).toEqual({
    ...output,
    worktreeBranchCleanupCandidate: false,
  });
  expect(await cleanupRemovedBranch(receipt, { ...target, branch: "other" }, head)).toBe("keep");
  renameSync(repo, join(root, "original"));
  git(root, "clone", "-qb", "main", join(root, "original"), repo);
  git(repo, "branch", "topic", head);
  expect(await cleanupRemovedBranch(receipt, target, head)).toBe("keep");
  expect(git(repo, "rev-parse", "topic")).toBe(head);
  renameSync(repo, join(root, "replacement"));
  renameSync(join(root, "original"), repo);
  expect(await cleanupRemovedBranch(receipt, target, head)).toBe("keep");
  expect(git(repo, "rev-parse", "topic")).toBe(head);
});

test("consume the receipt before Git commits so a crash or lost reply cannot delete a recreated branch", async () => {
  const { root, repo, head, receipt, request, target } = await cleanCandidate();
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  // The committed hook runs after ref deletion and before the worker can record its success.
  git(repo, "config", "canopy.fixturePath", root);
  writeFileSync(
    hook,
    '#!/bin/sh\nif test "$1" = committed; then root="$(git config canopy.fixturePath)"; cp "$root/receipt.outcome" "$root/at-commit"; fi\n',
    { mode: 0o700 },
  );
  expect(await cleanupRemovedBranch(receipt, target, head)).toBe("deleted");
  expect(await recoverRemoval(receipt, request)).toEqual({
    worktreeBranchCleanupCandidate: false,
    worktreeBranchDeleted: true,
  });
  const atCommit = readFileSync(join(root, "at-commit"));
  rmSync(hook);
  git(repo, "branch", "topic", head);
  expect(await cleanupRemovedBranch(receipt, target, head)).toBe("deleted");
  writeFileSync(`${receipt}.outcome`, atCommit);
  expect(await cleanupRemovedBranch(receipt, target, head)).toBe("keep");
  expect(git(repo, "rev-parse", "topic")).toBe(head);
});
