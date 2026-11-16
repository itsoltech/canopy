import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { eventually, failure, watchUntil } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("thread git summary and origin pull over the worker link", () => {
  const dir = tempDir("canopy-thread-git-");
  const capabilities = ["git_heads", "git_branch_switch_v1", "git_status_v1"];
  let f: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  const status = async (id: string) => {
    const response = await f.gw.api.getThreadGitStatus({ threadId: id });
    expect(response.supported).toBe(true);

    return response.status!;
  };

  const direct = async (cwd: string, threadId = Bun.randomUUIDv7()) => {
    const result = await f.command({
      commandId: Bun.randomUUIDv7(),
      kind: { case: "getThreadGitStatus", value: { cwd, threadId, expiresAtMs: BigInt(Date.now() + 25_000) } },
    });

    if (!result) throw new Error("Missing worker command response");

    return result;
  };

  const withGitWrapper = async (script: string, run: () => Promise<void>) => {
    const bin = join(dir, `git-wrapper-${Bun.randomUUIDv7()}`);
    mkdirSync(bin);
    const realGit = Bun.which("git")!;
    const path = join(bin, "git");
    writeFileSync(
      path,
      `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
${script}
const result = Bun.spawnSync([realGit, ...args]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
`,
    );
    chmodSync(path, 0o755);
    const previous = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previous}`;

    try {
      await run();
    } finally {
      process.env["PATH"] = previous;
    }
  };

  test("counts final HEAD differences once, plus untracked files, binary and unusual rename paths", async () => {
    const thread = await f.tree();
    const cwd = thread.cwd;
    writeFileSync(join(cwd, "edit.txt"), "one\ntwo\n");
    writeFileSync(join(cwd, "delete.txt"), "remove\n");
    writeFileSync(join(cwd, "rename\tbefore\n.txt"), "rename\n");
    writeFileSync(join(cwd, "cancelled.txt"), "old\n");
    writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1]));
    writeFileSync(join(cwd, ".gitignore"), "ignored*\n");
    git(cwd, "add", "--all");
    git(cwd, "commit", "-qm", "baseline");
    writeFileSync(join(cwd, "edit.txt"), "one\nstaged\n");
    writeFileSync(join(cwd, "cancelled.txt"), "staged\n");
    writeFileSync(join(cwd, "newtracked.txt"), "tracked\n");
    git(cwd, "add", "--all");
    writeFileSync(join(cwd, "edit.txt"), "one\nfinal\nthird\n");
    writeFileSync(join(cwd, "cancelled.txt"), "old\n");
    rmSync(join(cwd, "delete.txt"));
    git(cwd, "mv", "rename\tbefore\n.txt", "rename\tafter\n.txt");
    writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 2]));
    writeFileSync(join(cwd, "new\tfile\n.txt"), "new\nlast");
    writeFileSync(join(cwd, "ignored.txt"), "hidden\n");
    const index = git(cwd, "rev-parse", "--git-path", "index");
    const before = readFileSync(index);
    const head = git(cwd, "rev-parse", "HEAD");

    expect(await status(thread.id)).toMatchObject({
      isRepo: true,
      added: 2,
      modified: 3,
      deleted: 1,
      renamed: 1,
      conflicted: 0,
      files: 7,
      additions: 5,
      deletions: 2,
      binaryFiles: 1,
      linesComplete: true,
      hasOrigin: true,
      branch: thread.worktree!.branch,
      pullBranch: thread.worktree!.branch,
    });
    expect((await status(thread.id)).pullDisabledReason).toContain("uncommitted changes");
    expect(readFileSync(index)).toEqual(before);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
  });

  test("bounds untracked content and never follows a symlink to external content", async () => {
    const thread = await f.tree();
    const secret = join(dir, "outside.txt");
    writeFileSync(secret, "outside\n".repeat(100));
    symlinkSync(secret, join(thread.cwd, "link"));
    writeFileSync(join(thread.cwd, "binary"), Buffer.from([0, 5]));
    writeFileSync(join(thread.cwd, "empty"), "");
    writeFileSync(join(thread.cwd, "huge"), Buffer.alloc(1024 * 1024 + 1, 65));

    expect(await status(thread.id)).toMatchObject({
      files: 4,
      added: 4,
      additions: 1,
      binaryFiles: 1,
      linesComplete: false,
    });
  });

  test("supports an unborn HEAD and a directory outside git, and refuses oversized summaries", async () => {
    const cwd = join(dir, "unborn");
    mkdirSync(cwd);
    git(cwd, "init", "-qb", "first");
    writeFileSync(join(cwd, "staged"), "one\n");
    git(cwd, "add", "staged");
    writeFileSync(join(cwd, "staged"), "one\ntwo\n");
    writeFileSync(join(cwd, "new"), "three\n");
    expect((await direct(cwd)).threadGitStatus).toMatchObject({
      isRepo: true,
      branch: "first",
      added: 2,
      files: 2,
      additions: 3,
      linesComplete: true,
    });
    expect((await direct(dir)).threadGitStatus).toMatchObject({ isRepo: false, files: 0 });
    git(cwd, "add", "--all");
    git(cwd, "commit", "-qm", "first");
    expect((await direct(cwd)).threadGitStatus?.pullDisabledReason).toContain("no origin remote");

    for (let i = 0; i < 2001; i++) writeFileSync(join(cwd, `file-${i}`), "");
    expect(await direct(cwd)).toMatchObject({ ok: false, errorCode: "STATUS_TOO_LARGE" });
  });

  test("reports unresolved files as conflicts and incomplete line totals", async () => {
    const thread = await f.tree();
    commit(thread.cwd, "conflict", "base\n");
    const base = git(thread.cwd, "rev-parse", "HEAD");
    const other = `conflict-${thread.id}`;
    git(thread.cwd, "checkout", "-qb", other);
    commit(thread.cwd, "conflict", "other\n");
    git(thread.cwd, "checkout", "-q", thread.worktree!.branch);
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(base);
    commit(thread.cwd, "conflict", "ours\n");

    const merged = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", "merge", other], {
      cwd: thread.cwd,
    });

    expect(merged.exitCode).not.toBe(0);
    expect(await status(thread.id)).toMatchObject({ conflicted: 1, files: 1, linesComplete: false });
  });

  test("pulls the origin tracking branch with a different name, without hooks, and records next-turn context", async () => {
    const thread = await f.tree();
    const branch = thread.worktree!.branch;
    const remote = `tracking-${thread.id}`;
    git(thread.cwd, "push", "-qu", "origin", `HEAD:refs/heads/${remote}`);
    git(f.repo, "checkout", "-qb", `writer-${thread.id}`, `origin/${remote}`);
    const next = commit(f.repo, "from-origin.txt", "incoming\n");
    git(f.repo, "push", "-q", "origin", `HEAD:refs/heads/${remote}`);
    const hooks = join(dir, `hooks-${thread.id}`);
    mkdirSync(hooks);
    const marker = join(hooks, "called");

    for (const name of ["post-merge", "reference-transaction"]) {
      const path = join(hooks, name);
      writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(path, 0o755);
    }

    git(thread.cwd, "config", "core.hooksPath", hooks);
    expect((await status(thread.id)).pullBranch).toBe(remote);

    const updates = watchUntil(f.gw.api, thread.id, (events) =>
      events.some(
        (u) =>
          u.change.case === "event" &&
          u.change.value.event?.body.case === "notice" &&
          u.change.value.event.body.value.code === "origin_pulled",
      ),
    );

    const pulled = await f.gw.api.pullThreadOrigin({ threadId: thread.id });
    git(thread.cwd, "config", "--unset", "core.hooksPath");
    expect(pulled.status).toMatchObject({ files: 0, branch, pullBranch: remote });
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(next);
    expect(existsSync(marker)).toBe(false);
    expect((await updates).length).toBeGreaterThan(0);
    expect((await f.gw.runtime.runPromise(GatewayStore.use((s) => s.thread(thread.id)))).settings.branchNote).toContain(
      `origin/${remote}`,
    );
    f.disconnect();
    await eventually(
      () => f.gw.api.getOverview({}),
      (o) => !o.workers.find((w) => w.id === f.workerId)?.online,
    );
    await f.gw.api.sendMessage({ threadId: thread.id, text: "Continue", clientRequestId: "after-origin-pull" });
    const commands = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(f.workerId)));

    const command = commands.find(
      ({ command: c }) => c.kind.case === "startTurn" && c.kind.value.thread?.threadId === thread.id,
    )?.command;

    expect(command?.kind.case === "startTurn" && command.kind.value.input?.text).toContain(
      `The user pulled origin/${remote}`,
    );
    expect(commands.some(({ command: c }) => c.kind.case === "pullThreadOrigin")).toBe(false);
    await f.connect();
    await f.settled(thread);
  });

  test("without an origin upstream uses the exact current branch and never the base branch", async () => {
    const thread = await f.tree();
    const before = git(thread.cwd, "rev-parse", "HEAD");
    expect((await status(thread.id)).pullBranch).toBe(thread.worktree!.branch);
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("Origin has no branch named");
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(before);
    git(thread.cwd, "push", "-q", "origin", "HEAD");
    expect((await f.gw.api.pullThreadOrigin({ threadId: thread.id })).status?.files).toBe(0);
    git(thread.cwd, "config", `branch.${thread.worktree!.branch}.remote`, "origin");
    expect((await status(thread.id)).pullDisabledReason).toContain("no valid origin upstream");
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("no valid origin upstream");
  });

  test("refuses dirty, detached and diverged checkouts, preserving user work", async () => {
    const thread = await f.tree();
    const cwd = thread.cwd;
    const branch = thread.worktree!.branch;
    git(cwd, "push", "-qu", "origin", "HEAD");
    writeFileSync(join(cwd, "uncommitted"), "keep\n");
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("uncommitted changes");
    expect(readFileSync(join(cwd, "uncommitted"), "utf8")).toBe("keep\n");
    rmSync(join(cwd, "uncommitted"));
    git(cwd, "checkout", "-q", "--detach");
    expect((await status(thread.id)).pullDisabledReason).toContain("detached");
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("detached");
    git(cwd, "checkout", "-q", branch);
    git(f.repo, "checkout", "-qb", `diverged-${thread.id}`, `origin/${branch}`);
    commit(f.repo, "remote-work", "remote\n");
    git(f.repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    const before = commit(cwd, "local-work", "local\n");
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("fast-forward");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(cwd, "local-work"), "utf8")).toBe("local\n");
    expect(git(cwd, "stash", "list")).toBe("");
  });

  test("preserves ignored files that an incoming fast-forward would overwrite", async () => {
    const thread = await f.tree();
    commit(thread.cwd, ".gitignore", "private-local\n");
    git(thread.cwd, "push", "-qu", "origin", "HEAD");
    const before = git(thread.cwd, "rev-parse", "HEAD");
    git(f.repo, "checkout", "-qb", `ignored-${thread.id}`, before);
    writeFileSync(join(f.repo, "private-local"), "remote\n");
    git(f.repo, "add", "-f", "private-local");
    git(f.repo, "commit", "-qm", "incoming ignored path");
    git(f.repo, "push", "-q", "origin", `HEAD:refs/heads/${thread.worktree!.branch}`);
    writeFileSync(join(thread.cwd, "private-local"), "keep private data\n");
    expect((await status(thread.id)).files).toBe(0);
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("fast-forward");
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(thread.cwd, "private-local"), "utf8")).toBe("keep private data\n");
    expect(git(thread.cwd, "for-each-ref", "--format=%(refname)", "refs/canopy/pull/")).toBe("");
  });

  test("uses the shared checkout admission lock for queued turns and expires delayed worker commands", async () => {
    const thread = await f.tree();

    const side = (
      await f.gw.api.createThread({
        parentThreadId: thread.id,
        projectId: thread.projectId,
        workspaceId: thread.workspaceId,
        provider: Provider.CODEX,
      })
    ).thread!;

    await f.settled(side);
    rmSync(join(thread.cwd, "worker-started.txt"));

    const queued = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueTurn({
          threadId: side.id,
          userId: f.gw.userId,
          clientRequestId: "pull-busy",
          text: "queued",
        }),
      ),
    );

    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("using this directory");
    await f.gw.runtime.runPromise(GatewayStore.use((s) => s.failTurn(queued.id, "done", "platform")));
    const before = git(thread.cwd, "rev-parse", "HEAD");

    const expired = await f.command({
      commandId: Bun.randomUUIDv7(),
      kind: {
        case: "pullThreadOrigin",
        value: {
          threadId: thread.id,
          cwd: thread.cwd,
          expiresAtMs: BigInt(Date.now() - 1),
        },
      },
    });

    expect(expired).toMatchObject({ ok: false, errorCode: "SWITCH_EXPIRED" });
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(before);
  });

  test("shares one complete status scan across concurrent threads, subdirectories and checkout aliases", async () => {
    const thread = await f.tree();
    const alias = join(dir, `alias-${thread.id}`);
    const nested = join(thread.cwd, "nested");
    mkdirSync(nested);
    symlinkSync(thread.cwd, alias, "dir");
    const scans = join(dir, `scans-${thread.id}`);
    const gate = join(dir, `gate-${thread.id}`);
    await withGitWrapper(
      `
if (args.includes("status")) {
  appendFileSync(${JSON.stringify(scans)}, "scan\\n");
  while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
}`,
      async () => {
        const leader = direct(thread.cwd);
        await eventually(async () => existsSync(scans), Boolean);
        const paths = [thread.cwd, nested, alias];
        const followers = Array.from({ length: 20 }, (_, i) => direct(paths[i % paths.length]!));
        writeFileSync(gate, "go");
        const results = await Promise.all([leader, ...followers]);
        expect(results.every((r) => r.ok && r.threadGitStatus?.files === 0)).toBe(true);
        expect(readFileSync(scans, "utf8")).toBe("scan\n");
        writeFileSync(join(thread.cwd, "fresh-change"), "new\n");
        expect((await direct(alias)).threadGitStatus?.files).toBe(1);
        expect(readFileSync(scans, "utf8")).toBe("scan\nscan\n");
      },
    );
  });

  test("pins the exact fetched origin branch even when another fetch replaces FETCH_HEAD", async () => {
    const thread = await f.tree();
    const branch = thread.worktree!.branch;
    const base = git(thread.cwd, "rev-parse", "HEAD");
    git(thread.cwd, "push", "-qu", "origin", "HEAD");
    git(f.repo, "checkout", "-qb", `wanted-${thread.id}`, base);
    const wanted = commit(f.repo, "wanted", "correct\n");
    git(f.repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    const intruder = `intruder-${thread.id}`;
    git(f.repo, "checkout", "-qb", intruder, base);
    const other = commit(f.repo, "wrong", "wrong branch\n");
    git(f.repo, "push", "-q", "origin", "HEAD");
    await withGitWrapper(
      `
if (args.includes("fetch") && args.some((arg) => arg.includes(":refs/canopy/pull/"))) {
  const result = Bun.spawnSync([realGit, ...args]);
  if (result.exitCode) process.exit(result.exitCode);
  const replaced = Bun.spawnSync([realGit, "fetch", "origin", ${JSON.stringify(`refs/heads/${intruder}`)}]);
  if (replaced.exitCode) process.exit(replaced.exitCode);
  process.exit(0);
}`,
      async () => {
        await f.gw.api.pullThreadOrigin({ threadId: thread.id });
      },
    );
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(wanted);
    expect(git(thread.cwd, "rev-parse", "FETCH_HEAD")).toBe(other);
    expect(existsSync(join(thread.cwd, "wrong"))).toBe(false);
    expect(git(thread.cwd, "for-each-ref", "--format=%(refname)", "refs/canopy/pull/")).toBe("");
  });

  test("a sole staged change reversed in the working tree stays dirty with zero net lines", async () => {
    const thread = await f.tree();
    const before = readFileSync(join(thread.cwd, "README.md"));
    writeFileSync(join(thread.cwd, "README.md"), "staged\n");
    git(thread.cwd, "add", "README.md");
    writeFileSync(join(thread.cwd, "README.md"), before);
    expect(await status(thread.id)).toMatchObject({ files: 1, modified: 1, additions: 0, deletions: 0 });
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("uncommitted changes");
  });

  test("old and offline workers report an unavailable summary and never queue a pull", async () => {
    const thread = await f.tree();
    capabilities.splice(capabilities.indexOf("git_status_v1"), 1);
    f.disconnect();
    await f.connect();
    expect(await f.gw.api.getThreadGitStatus({ threadId: thread.id })).toMatchObject({ supported: false });
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("Update this computer");
    expect((await f.gw.api.getOverview({})).workers.find((w) => w.id === f.workerId)?.gitStatus).toBe(false);
    f.disconnect();
    await eventually(
      () => f.gw.api.getOverview({}),
      (o) => !o.workers.find((w) => w.id === f.workerId)?.online,
    );
    expect((await f.gw.api.getThreadGitStatus({ threadId: thread.id })).detail).toContain("offline");
    expect(await failure(f.gw.api.pullThreadOrigin({ threadId: thread.id }))).toContain("offline");
    const commands = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(f.workerId)));
    expect(commands.some(({ command: c }) => c.kind.case === "pullThreadOrigin")).toBe(false);
  });
});
