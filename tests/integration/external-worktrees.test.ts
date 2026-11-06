import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { eventually, failure } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("external worktrees over the worker link", () => {
  const dir = tempDir("canopy-external-worktrees-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  const path = join(dir, "outside Canopy");
  const detached = join(dir, "detached");
  const locked = join(dir, "locked");
  const prunable = join(dir, "prunable");
  let managed: ui.Thread;

  const refs = () => f.gw.api.listGitRefs({ workspaceId: f.workspace.id });

  const pick = (id: string, workspaceId = f.workspace.id, projectId = f.project.id) =>
    f.gw.api.createThread({
      projectId,
      workspaceId,
      provider: Provider.CODEX,
      workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
      worktreeId: id,
    });

  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities: ["git_worktree_discovery", "git_heads", "provisional_branches"] });
    git(f.repo, "worktree", "add", "-qb", "external/with-spaces", path);
    git(f.repo, "worktree", "add", "-q", "--detach", detached);
    git(f.repo, "worktree", "add", "-qb", "external/locked", locked);
    git(f.repo, "worktree", "lock", "--reason", "in use elsewhere", locked);
    git(f.repo, "worktree", "add", "-qb", "external/prunable", prunable);
    rmSync(prunable, { recursive: true });
    managed = await f.tree();
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  });

  test("merges real git entries with the registry, excludes the current checkout, and stays read-only", async () => {
    const result = await refs();
    expect(result.worktrees).toHaveLength(5);
    expect(result.worktrees.some((w) => w.path === f.repo)).toBe(false);
    expect(result.worktrees.find((w) => w.path === path)).toMatchObject({
      external: true,
      branch: "external/with-spaces",
    });
    expect(result.worktrees.find((w) => w.path === detached)).toMatchObject({ external: true, branch: "" });
    expect(result.worktrees.find((w) => w.path === detached)?.detachedCommit).toBe(
      git(f.repo, "rev-parse", "HEAD").slice(0, 12),
    );
    expect(result.worktrees.find((w) => w.path === locked)).toMatchObject({
      locked: true,
      unavailableReason: "Locked worktree",
    });
    expect(result.worktrees.find((w) => w.path === prunable)).toMatchObject({ prunable: true, missing: true });
    expect(result.worktrees.find((w) => w.path === managed.cwd)).toMatchObject({
      id: managed.worktree!.id,
      external: false,
    });
    expect(await f.sql((sql) => sql`SELECT id FROM worktrees WHERE external`)).toHaveLength(0);
    const settings = await f.gw.api.listWorktrees({ projectId: f.project.id });
    expect(settings.entries.find((e) => e.worktree?.path === path)).toMatchObject({ detail: "Created outside Canopy" });
  });

  test("adopts only on use, starts in the directory and tracks subsequent branch changes", async () => {
    const external = (await refs()).worktrees.find((w) => w.path === path)!;
    const t = (await pick(external.id)).thread!;
    expect(t.cwd).toBe(path);
    expect(t.worktree).toMatchObject({ external: true, provisionalBranch: false });
    await eventually(
      () => f.gw.api.getThread({ threadId: t.id }),
      (r) => r.thread?.status === "idle",
    );
    expect(readFileSync(join(path, "worker-started.txt"), "utf8")).toBe(path);
    git(path, "switch", "-qc", "external/live-branch");
    await eventually(
      () => f.gw.api.getThread({ threadId: t.id }),
      (r) => r.thread?.worktree?.branch === "external/live-branch",
    );
    const again = (await pick(external.id)).thread!;
    expect(again.worktree?.id).toBe(t.worktree?.id);

    const record = await f.sql(
      (sql) => sql`SELECT external, branch_source FROM worktrees WHERE id=${external.id}::uuid`,
    );

    expect(record).toEqual([{ external: true, branch_source: "fixed" }]);
  });

  test("detached selection starts a thread without inventing a branch", async () => {
    const external = (await refs()).worktrees.find((w) => w.path === detached)!;
    const t = (await pick(external.id)).thread!;
    expect(t.cwd).toBe(detached);
    expect(t.worktree).toMatchObject({ external: true, branch: "", detachedCommit: external.detachedCommit });
  });

  test("unusable and stale selections fail, even if the picker was opened before a lock", async () => {
    const result = await refs();

    for (const target of [locked, prunable]) {
      const tree = result.worktrees.find((w) => w.path === target)!;
      expect(await failure(pick(tree.id))).toMatch(/Locked|missing/i);
    }

    const stale = join(dir, "stale");
    git(f.repo, "worktree", "add", "-qb", "external/stale", stale);

    const response = await f.command({
      commandId: Bun.randomUUIDv7(),
      kind: { case: "listGitRefs", value: { repoPath: f.repo, freshWorktrees: true } },
    });

    expect(response?.gitRefs?.worktrees?.some((w) => w.path === stale)).toBe(true);
    const tree = (await refs()).worktrees.find((w) => w.path === stale)!;
    git(f.repo, "worktree", "lock", stale);
    expect(await failure(pick(tree.id))).toContain("Locked");
  });

  test("cleanup, manual removal and branch generation never modify adopted external worktrees", async () => {
    const tree = (await refs()).worktrees.find((w) => w.path === path)!;
    expect(await failure(f.gw.api.removeWorktree({ worktreeId: tree.id, confirmLocalChanges: true }))).toContain(
      "outside Canopy",
    );
    await f.settings({ cleanupUnchanged: true, cleanupSettled: true, cleanupMerged: true, cleanupInactiveDays: 1 });
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === tree.id)).toMatchObject({
      removed: false,
      wouldRemove: false,
    });
    expect(existsSync(path)).toBe(true);
    expect(git(path, "branch", "--show-current")).toBe("external/live-branch");
    expect(await f.gw.runtime.runPromise(GatewayStore.use((s) => s.claimBranchName(tree.id, 3)))).toBeUndefined();
    await expect(f.sql((sql) => sql`UPDATE worktrees SET external=false WHERE id=${tree.id}::uuid`)).rejects.toThrow();
  });

  test("owner and repository scoping reject foreign workspaces, ids and substituted paths", async () => {
    const otherUser = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@x", "Other")));

    const foreignProject = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.createProject(otherUser, "Foreign")),
    );

    const foreignWorkspace = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.createWorkspace({ projectId: foreignProject.id, workerId: f.workerId, rootPath: f.repo, label: "Foreign" }),
      ),
    );

    expect(await failure(f.gw.api.listGitRefs({ workspaceId: foreignWorkspace.id }))).toContain("workspace not found");
    const tree = (await refs()).worktrees.find((w) => w.path === path)!;
    expect(await failure(pick(tree.id, foreignWorkspace.id, foreignProject.id))).toContain("workspace not found");
    expect(await failure(pick("../../escape"))).toContain("Worktree unavailable");
    const substituted = join(dir, "substituted");
    git(f.repo, "worktree", "add", "-qb", "external/substituted", substituted);
    const saved = join(dir, "saved");
    renameSync(substituted, saved);
    const unrelated = join(dir, "unrelated");
    mkdirSync(unrelated);
    git(unrelated, "init", "-q");
    symlinkSync(unrelated, substituted);

    const result = await f.command({
      commandId: Bun.randomUUIDv7(),
      kind: { case: "listGitRefs", value: { repoPath: f.repo, freshWorktrees: true, worktreesOnly: true } },
    });

    expect(result?.gitRefs?.worktrees?.find((w) => w.path === substituted)?.unavailableReason).toContain(
      "no longer belongs",
    );
  });

  test("managed worktrees under a symlinked location stay managed and appear once", async () => {
    const real = join(dir, "managed-real");
    const alias = join(dir, "managed-alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");
    await f.settings({ location: alias });
    const thread = await f.tree();
    const listed = (await refs()).worktrees;
    expect(listed.filter((tree) => tree.id === thread.worktree!.id)).toHaveLength(1);
    expect(listed.find((tree) => tree.id === thread.worktree!.id)).toMatchObject({
      external: false,
      unavailableReason: "",
    });
    const settings = await f.gw.api.listWorktrees({ projectId: f.project.id });
    expect(
      settings.entries.filter((entry) => entry.worktree?.path.endsWith(thread.cwd.split("/").at(-1)!)),
    ).toHaveLength(1);
  });
});
