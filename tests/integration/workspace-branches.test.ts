import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { tempDir } from "@canopy/testing";
import { eventually, failure } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

const capabilities = [
  "git_heads",
  "git_branch_switch_v1",
  "git_branch_stash_v1",
  "workspace_branch_switch_v1",
  "git_worktree_discovery",
];

describe.skipIf(!dockerAvailable)("composer branch selection and consented stash recovery over WorkerLink", () => {
  const dir = tempDir("canopy-workspace-branches-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("switches the current checkout before any thread exists", async () => {
    git(f.repo, "branch", "composer-choice");
    const listed = await f.gw.api.listWorkspaceBranches({ workspaceId: f.workspace.id });
    expect(listed.supported).toBe(true);
    expect(listed.refs?.currentBranch).toBe("main");
    expect(listed.refs?.refs.some((ref) => ref.name === "composer-choice")).toBe(true);
    const result = await f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, branch: "composer-choice" });
    expect(result.refs?.currentBranch).toBe("composer-choice");
    expect(result.detail).toBe("");
    expect((await f.gw.api.listThreads({})).threads).toHaveLength(0);
    await f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, branch: "main" });
  });

  test("requires fresh consent and preserves staged, unstaged, untracked files and existing stashes", async () => {
    writeFileSync(join(f.repo, "old-stash.txt"), "older saved work");
    git(f.repo, "stash", "push", "-u", "-m", "existing user stash");
    const previous = git(f.repo, "rev-parse", "refs/stash");
    writeFileSync(join(f.repo, "README.md"), "staged\n");
    git(f.repo, "add", "README.md");
    writeFileSync(join(f.repo, "README.md"), "staged\nunstaged\n");
    const untracked = join(f.repo, ":(exclude) keep.txt");
    writeFileSync(untracked, "untracked\n");
    expect((await f.gw.api.listWorkspaceBranches({ workspaceId: f.workspace.id })).refs?.dirty).toBe(true);
    expect(
      await failure(f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, branch: "composer-choice" })),
    ).toContain("uncommitted changes");
    expect(git(f.repo, "branch", "--show-current")).toBe("main");

    const result = await f.gw.api.switchWorkspaceBranch({
      workspaceId: f.workspace.id,
      branch: "composer-choice",
      stashChanges: true,
    });

    expect(result.detail).toBe("");
    expect(result.refs).toMatchObject({ currentBranch: "composer-choice", dirty: true });
    expect(git(f.repo, "show", ":README.md")).toBe("staged");
    expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("staged\nunstaged\n");
    expect(readFileSync(untracked, "utf8")).toBe("untracked\n");
    expect(git(f.repo, "rev-parse", "refs/stash")).toBe(previous);
    expect(git(f.repo, "for-each-ref", "--format=%(refname)", "refs/canopy/branch-switch/")).toBe("");
    git(f.repo, "reset", "--hard", "HEAD");
    rmSync(untracked);
    await f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, branch: "main" });
  });

  test("restores the original index and untracked files when Git refuses the switch", async () => {
    const thread = await f.tree();
    const original = git(thread.cwd, "branch", "--show-current");
    writeFileSync(join(thread.cwd, "README.md"), "staged rollback\n");
    git(thread.cwd, "add", "README.md");
    writeFileSync(join(thread.cwd, "README.md"), "staged rollback\nunstaged rollback\n");
    writeFileSync(join(thread.cwd, "untracked.txt"), "rollback\n");
    const before = git(thread.cwd, "status", "--porcelain=v1");
    expect(
      await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "main", stashChanges: true })),
    ).toContain("worktree");
    expect(git(thread.cwd, "branch", "--show-current")).toBe(original);
    expect(git(thread.cwd, "show", ":README.md")).toBe("staged rollback");
    expect(readFileSync(join(thread.cwd, "README.md"), "utf8")).toBe("staged rollback\nunstaged rollback\n");
    expect(readFileSync(join(thread.cwd, "untracked.txt"), "utf8")).toBe("rollback\n");
    expect(git(thread.cwd, "status", "--porcelain=v1")).toBe(before);
  });

  test("reports a successful switch with restore conflicts and retains recoverable stash objects", async () => {
    const thread = await f.tree();
    git(f.repo, "switch", "-c", "conflicting-choice");
    commit(f.repo, "README.md", "target version\n");
    git(f.repo, "switch", "main");
    writeFileSync(join(thread.cwd, "README.md"), "local version\n");
    writeFileSync(join(thread.cwd, "local.txt"), "local untracked\n");

    const result = await f.gw.api.switchThreadBranch({
      threadId: thread.id,
      branch: "conflicting-choice",
      stashChanges: true,
    });

    expect(result.thread?.worktree?.branch).toBe("conflicting-choice");
    expect(result.detail).toContain("saved stash is preserved at refs/canopy/branch-switch/");
    expect(git(thread.cwd, "branch", "--show-current")).toBe("conflicting-choice");
    expect(git(thread.cwd, "stash", "list")).toContain("Canopy recovery");
    const saved = result.detail.match(/preserved at (refs\/canopy\/branch-switch\/[^;]+)/)![1]!;
    expect(git(thread.cwd, "show", `${saved}:README.md`)).toBe("local version");
    expect(git(thread.cwd, "show", `${saved}^3:local.txt`)).toBe("local untracked");
    expect((await f.entry(thread.worktree!.id)).worktree?.branch).toBe("conflicting-choice");
  });

  test("switches freshly discovered external worktrees without registration or changing the workspace checkout", async () => {
    const external = join(dir, "external");
    git(f.repo, "worktree", "add", "-qb", "external/start", external);
    git(f.repo, "branch", "external/choice");
    const inventory = await f.gw.api.listGitRefs({ workspaceId: f.workspace.id });
    const tree = inventory.worktrees.find((tree) => tree.path === external)!;
    expect(tree.external).toBe(true);
    const request = { workspaceId: f.workspace.id, worktreeId: tree.id };
    expect((await f.gw.api.listWorkspaceBranches(request)).refs?.currentBranch).toBe("external/start");
    const result = await f.gw.api.switchWorkspaceBranch({ ...request, branch: "external/choice" });
    expect(result.refs?.currentBranch).toBe("external/choice");
    expect(git(f.repo, "branch", "--show-current")).toBe("main");
    const rows = await f.sql((sql) => sql`SELECT id FROM worktrees WHERE id=${tree.id}::uuid`);
    expect(rows).toHaveLength(0);
    expect(
      await failure(f.gw.api.switchWorkspaceBranch({ ...request, worktreeId: Bun.randomUUIDv7(), branch: "main" })),
    ).toContain("Worktree unavailable");
  });

  test("rejects a stale external id after the path is replaced with another repository", async () => {
    const external = join(dir, "external-replaced");
    git(f.repo, "worktree", "add", "-qb", "external/replaced", external);

    const inventory = await eventually(
      () => f.gw.api.listGitRefs({ workspaceId: f.workspace.id }),
      (listed) => listed.worktrees.some((tree) => tree.path === external),
    );

    const tree = inventory.worktrees.find((tree) => tree.path === external)!;
    rmSync(external, { recursive: true });
    mkdirSync(external);
    git(external, "init", "-qb", "private");
    commit(external);
    expect(
      await failure(f.gw.api.listWorkspaceBranches({ workspaceId: f.workspace.id, worktreeId: tree.id })),
    ).toContain("no longer belongs");
    expect(
      await failure(
        f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, worktreeId: tree.id, branch: "private" }),
      ),
    ).toContain("no longer belongs");
    expect(git(external, "branch", "--show-current")).toBe("private");
  });

  test("preserves an ignored working file whose deletion is staged", async () => {
    const thread = await f.tree();
    writeFileSync(join(thread.cwd, ".gitignore"), "tracked.txt\n");
    writeFileSync(join(thread.cwd, "tracked.txt"), "original\n");
    git(thread.cwd, "add", "-f", ".gitignore", "tracked.txt");
    git(thread.cwd, "commit", "-qm", "tracked ignored fixture");
    git(thread.cwd, "branch", "ignored-choice");
    git(thread.cwd, "rm", "--cached", "tracked.txt");
    writeFileSync(join(thread.cwd, "tracked.txt"), "unique ignored contents\n");
    const before = git(thread.cwd, "status", "--porcelain=v1");

    const result = await f.gw.api.switchThreadBranch({
      threadId: thread.id,
      branch: "ignored-choice",
      stashChanges: true,
    });

    expect(result.detail).toBe("");
    expect(result.thread?.worktree?.branch).toBe("ignored-choice");
    expect(readFileSync(join(thread.cwd, "tracked.txt"), "utf8")).toBe("unique ignored contents\n");
    expect(git(thread.cwd, "status", "--porcelain=v1")).toBe(before);
  });

  test("rejects intent-to-add without losing file contents or mutating HEAD", async () => {
    const path = join(f.repo, "intent-to-add.txt");
    writeFileSync(path, "keep intended contents\n");
    git(f.repo, "add", "-N", "intent-to-add.txt");
    const before = git(f.repo, "status", "--porcelain=v2");
    expect(
      await failure(
        f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, branch: "composer-choice", stashChanges: true }),
      ),
    ).toContain("intent-to-add");
    expect(git(f.repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(path, "utf8")).toBe("keep intended contents\n");
    expect(git(f.repo, "status", "--porcelain=v2")).toBe(before);
    git(f.repo, "reset", "--", "intent-to-add.txt");
    rmSync(path);
  });

  test("rejects another owner's workspace before contacting its worker", async () => {
    const workspace = await f.gw.runtime.runPromise(
      GatewayStore.use((store) =>
        Effect.gen(function* () {
          const owner = yield* store.ensureUser("workspace-branches-other@localhost", "Other");
          const project = yield* store.createProject(owner, "Private");
          const worker = yield* store.addWorker({ name: "Private", ownerUserId: owner });

          return yield* store.createWorkspace({
            projectId: project.id,
            workerId: worker.workerId,
            rootPath: f.repo,
            label: "",
          });
        }),
      ),
    );

    expect(await failure(f.gw.api.listWorkspaceBranches({ workspaceId: workspace.id }))).toContain(
      "workspace not found",
    );
    expect(await failure(f.gw.api.switchWorkspaceBranch({ workspaceId: workspace.id, branch: "main" }))).toContain(
      "workspace not found",
    );
  });

  test("the composer shares turn admission locks and worktree removal reservations", async () => {
    const thread = await f.tree();
    const request = { workspaceId: f.workspace.id, worktreeId: thread.worktree!.id, branch: "composer-choice" };

    const turn = await f.gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.enqueueTurn({
          threadId: thread.id,
          userId: f.gw.userId,
          clientRequestId: "composer-busy",
          text: "queued",
        }),
      ),
    );

    expect(await failure(f.gw.api.switchWorkspaceBranch(request))).toContain("using this directory");
    await f.gw.runtime.runPromise(GatewayStore.use((store) => store.failTurn(turn.id, "fixture finished", "platform")));
    await f.sql(
      (sql) =>
        sql`UPDATE worktrees SET removal_token=${Bun.randomUUIDv7()}::uuid WHERE id=${thread.worktree!.id}::uuid`,
    );

    try {
      expect(await failure(f.gw.api.switchWorkspaceBranch(request))).toContain("Worktree unavailable");
    } finally {
      await f.sql((sql) => sql`UPDATE worktrees SET removal_token=NULL WHERE id=${thread.worktree!.id}::uuid`);
    }
  });

  test("dirty submodules are rejected before snapshot or mutation", async () => {
    const source = join(dir, "submodule-source");
    mkdirSync(source);
    git(source, "init", "-qb", "main");
    commit(source);
    const thread = await f.tree();
    git(thread.cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
    git(thread.cwd, "commit", "-qm", "submodule fixture");
    const original = git(thread.cwd, "branch", "--show-current");
    writeFileSync(join(thread.cwd, "module", "README.md"), "submodule work\n");
    expect(
      await failure(
        f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "composer-choice", stashChanges: true }),
      ),
    ).toContain("changed submodules");
    expect(git(thread.cwd, "branch", "--show-current")).toBe(original);
    expect(readFileSync(join(thread.cwd, "module", "README.md"), "utf8")).toBe("submodule work\n");
  });

  const hook = (script: string) => {
    const hooks = join(dir, Bun.randomUUIDv7());
    mkdirSync(hooks);
    const path = join(hooks, "post-checkout");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    git(f.repo, "config", "core.hooksPath", hooks);
  };

  test("a failing post-checkout hook still acknowledges the changed branch and persists the agent notice", async () => {
    const thread = await f.tree();
    git(f.repo, "branch", "hook-choice");
    writeFileSync(join(thread.cwd, "hook-work.txt"), "keep hook work\n");
    hook("exit 1");

    try {
      const result = await f.gw.api.switchThreadBranch({
        threadId: thread.id,
        branch: "hook-choice",
        stashChanges: true,
      });

      expect(result.thread?.worktree?.branch).toBe("hook-choice");
      expect(result.detail).toContain("Git did not finish cleanly");
      expect(readFileSync(join(thread.cwd, "hook-work.txt"), "utf8")).toBe("keep hook work\n");
      const stored = await f.gw.runtime.runPromise(GatewayStore.use((store) => store.thread(thread.id)));
      expect(stored.settings.branchNote).toContain("hook-choice");
    } finally {
      git(f.repo, "config", "--unset", "core.hooksPath");
    }
  });

  test("an expired command recovers a stash after checkout has already changed HEAD", async () => {
    const thread = await f.tree();
    git(f.repo, "branch", "timed-choice");
    writeFileSync(join(thread.cwd, "timed-work.txt"), "keep timed work\n");
    hook("sleep 2");

    try {
      const result = await f.command({
        commandId: Bun.randomUUIDv7(),
        kind: {
          case: "switchThreadBranch",
          value: {
            threadId: thread.id,
            cwd: thread.cwd,
            branch: "timed-choice",
            stashChanges: true,
            expiresAtMs: BigInt(Date.now() + 500),
          },
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.switchedHead?.branch).toBe("timed-choice");
      expect(result?.branchSwitchWarning).toContain("Git did not finish cleanly");
      expect(readFileSync(join(thread.cwd, "timed-work.txt"), "utf8")).toBe("keep timed work\n");
    } finally {
      git(f.repo, "config", "--unset", "core.hooksPath");
    }
  });

  test("worker cleanup cannot enter a checkout while its stash is temporarily cleared", async () => {
    const thread = await f.tree();
    git(f.repo, "branch", "fenced-choice");
    writeFileSync(join(thread.cwd, "fenced-work.txt"), "keep fenced work\n");
    hook("touch .switch-started\nwhile ! test -f .switch-release; do sleep 0.02; done");

    const switching = f.gw.api.switchWorkspaceBranch({
      workspaceId: f.workspace.id,
      worktreeId: thread.worktree!.id,
      branch: "fenced-choice",
      stashChanges: true,
    });

    try {
      await eventually(async () => existsSync(join(thread.cwd, ".switch-started")), Boolean);

      const removal = await f.command({
        commandId: Bun.randomUUIDv7(),
        kind: {
          case: "removeWorktree",
          value: {
            target: { id: thread.worktree!.id, path: thread.cwd, repoRoot: f.repo, branch: "fenced-choice" },
            expectedHeadCommit: git(thread.cwd, "rev-parse", "HEAD"),
            confirmLocalChanges: true,
          },
        },
      });

      expect(removal).toMatchObject({ ok: false, errorCode: "WORKTREE_BUSY" });
      expect(removal?.errorMessage).toContain("branch switch is in progress");
    } finally {
      writeFileSync(join(thread.cwd, ".switch-release"), "release\n");
      await switching;
      git(f.repo, "config", "--unset", "core.hooksPath");
    }

    expect(readFileSync(join(thread.cwd, "fenced-work.txt"), "utf8")).toBe("keep fenced work\n");
  });

  test("a rollback restore failure retains the exact stash and explains recovery", async () => {
    const thread = await f.tree();
    git(thread.cwd, "branch", "-m", "rollback-failure-start");
    git(f.repo, "branch", "rollback-failure-target");
    writeFileSync(join(thread.cwd, "rollback-work.txt"), "original saved work\n");
    hook(
      "git -c core.hooksPath=/dev/null switch --no-guess rollback-failure-start\nprintf 'newer hook work\\n' > rollback-work.txt\nexit 1",
    );

    try {
      const message = await failure(
        f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "rollback-failure-target", stashChanges: true }),
      );

      expect(message).toContain("saved stash is preserved");
      const saved = message.match(/preserved at (refs\/canopy\/branch-switch\/[^;]+)/)![1]!;
      expect(git(thread.cwd, "show", `${saved}^3:rollback-work.txt`)).toBe("original saved work");
      expect(readFileSync(join(thread.cwd, "rollback-work.txt"), "utf8")).toBe("newer hook work\n");
      expect(git(thread.cwd, "branch", "--show-current")).toBe("rollback-failure-start");
    } finally {
      git(f.repo, "config", "--unset", "core.hooksPath");
    }
  });

  test("a remote-name collision does not acknowledge a branch that was already selected", async () => {
    const thread = await f.tree();
    const current = git(thread.cwd, "branch", "--show-current");
    git(f.repo, "update-ref", `refs/remotes/origin/${current}`, "HEAD");
    writeFileSync(join(thread.cwd, "collision-work.txt"), "keep collision work\n");
    expect(
      await failure(
        f.gw.api.switchThreadBranch({
          threadId: thread.id,
          branch: `origin/${current}`,
          remote: true,
          stashChanges: true,
        }),
      ),
    ).toContain("already exists");
    expect(git(thread.cwd, "branch", "--show-current")).toBe(current);
    expect(readFileSync(join(thread.cwd, "collision-work.txt"), "utf8")).toBe("keep collision work\n");
  });

  test("capability checks reject consented stashing on older workers without mutating files", async () => {
    capabilities.splice(capabilities.indexOf("git_branch_stash_v1"), 1);
    f.disconnect();
    await f.connect();
    writeFileSync(join(f.repo, "consent.txt"), "keep\n");
    expect(
      await failure(
        f.gw.api.switchWorkspaceBranch({ workspaceId: f.workspace.id, branch: "composer-choice", stashChanges: true }),
      ),
    ).toContain("Update this computer");
    expect(readFileSync(join(f.repo, "consent.txt"), "utf8")).toBe("keep\n");
    rmSync(join(f.repo, "consent.txt"));
    capabilities.splice(capabilities.indexOf("workspace_branch_switch_v1"), 1);
    f.disconnect();
    await f.connect();
    const listed = await f.gw.api.listWorkspaceBranches({ workspaceId: f.workspace.id });
    expect(listed.supported).toBe(false);
    expect(listed.detail).toContain("Update this computer");
  });
});
