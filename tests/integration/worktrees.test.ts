/**
 * Git worktrees end to end (docs/worktrees.md): real gateway, PostgreSQL, gRPC link and WorkerHost on a temporary
 * repository (a bare origin and a clone). A local Codex stand-in records each thread's cwd; GenerateText is stubbed
 * at the worker so the semantic branch name is deterministic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema, MentionKind, Provider, ui, type GenerateText } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { qualifyId } from "@canopy/domain/computers";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

function commit(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  sh(repo, "add", file);
  sh(repo, "commit", "-q", "-m", `change ${file}`);

  return sh(repo, "rev-parse", "HEAD");
}

describe.skipIf(!dockerAvailable)("git worktrees through the worker link", () => {
  const dir = tempDir("canopy-worktrees-");
  const dataDir = join(dir, "worker-data");
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const other = join(dir, "other-clone");
  const codexHome = join(dir, "device-codex");
  const executable = join(dir, "codex");
  const generated: GenerateText[] = [];
  let generatedText = "feat/add-dark-mode";
  let gw: TestGateway;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let host: WorkerHost;
  let link: GatewayLink;
  let workerId: string;
  let project: ui.Project;
  let workspace: ui.Workspace;
  let localMain = "";

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
    copyFileSync(new URL("./fixtures/directory-codex.ts", import.meta.url), executable);
    chmodSync(executable, 0o755);
    sh(dir, "init", "-q", "--bare", "-b", "main", origin);
    sh(dir, "clone", "-q", origin, repo);
    localMain = commit(repo, "README.md", "hello");
    sh(repo, "push", "-q", "origin", "main");
    sh(repo, "remote", "set-head", "origin", "main");
    sh(repo, "branch", "-q", "feature/old");
    sh(dir, "clone", "-q", origin, other);

    gw = await startTestGateway();
    const worker = await gw.addWorker("git-worker");
    workerId = worker.workerId;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          { codex: { enabled: true, executablePath: executable }, claude: { enabled: false } },
          gw.userId,
        ),
      ),
    );
    runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
    host = new WorkerHost({
      runtime,
      dataDir,
      clientVersion: "test",
      deviceHomes: { codex: codexHome, claude: join(dir, "device-claude") },
    });
    // The text-generation stub: the model's answer for semantic branch names (and titles).
    const handle = host.handleCommand.bind(host);
    host.handleCommand = async (command) => {
      if (command.kind.case !== "generateText") return handle(command);
      generated.push(command.kind.value);

      return { commandId: command.commandId, ok: true, generatedText };
    };

    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        capabilities: ["worktrees", "generate_text"],
        worktreesRoot: host.worktreesRoot,
        homeDirectory: homedir(),
        ...(await runtime.runPromise(journalHello())),
      },
    });
    void serveLink(link, host, runtime);
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === workerId && w.appliedVersion > 0n && w.worktrees),
    );
    project = (await gw.api.createProject({ name: "Repo" })).project!;
    workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: repo })).workspace!;
  }, 60_000);

  afterAll(async () => {
    link?.close();
    await host?.close();
    await runtime?.dispose();
    await gw?.close();
  });

  const settings = async (projectId: string, change: Partial<ui.WorktreeSettings>, scopeWorker = "") => {
    const current = await gw.api.getWorktreeSettings({ projectId, workerId: scopeWorker });

    return gw.api.updateWorktreeSettings({
      projectId,
      workerId: scopeWorker,
      expectedVersion: current.version,
      settings: { ...current.settings, ...change },
    });
  };

  const newWorktreeThread = async (initialMessage: string, baseRef = "") =>
    (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        initialMessage,
        workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        baseRef,
      })
    ).thread!;

  const idle = (threadId: string) =>
    eventually(
      () => gw.api.getThread({ threadId }),
      (r) => r.thread?.status === "idle" || r.thread?.status === "running",
    );

  test("refs: current and default branch, local and remote branches; defaults of the settings", async () => {
    const refs = await gw.api.listGitRefs({ workspaceId: workspace.id });
    expect(refs.supported).toBe(true);
    expect(refs.refs).toMatchObject({ isRepo: true, currentBranch: "main", defaultBranch: "main", dirty: false });
    expect(refs.refs?.repoRoot).toBe(realpathSync(repo));
    const names = refs.refs!.refs.map((r) => `${r.remote ? "remote" : "local"}:${r.name}`);
    expect(names).toEqual(expect.arrayContaining(["local:main", "local:feature/old", "remote:origin/main"]));
    expect(names).not.toContain("remote:origin/HEAD");
    expect(refs.refs!.refs.find((r) => r.name === "main")?.upstream).toBe("origin/main");
    expect(refs.worktrees).toEqual([]);
    expect(refs.settings).toMatchObject({
      defaultMode: ui.WorkspaceMode.CHECKOUT,
      branchNaming: ui.BranchNaming.SEMANTIC,
      startFromRemote: false,
    });
  });

  test("a new worktree from the local base with a prefixed name; the thread runs in it; names never collide", async () => {
    await settings("", { branchNaming: ui.BranchNaming.PREFIX, branchPrefix: "wt" });
    const thread = await newWorktreeThread("Fix the login bug\nmore detail");
    expect(thread.worktree?.branch).toBe("wt/fix-the-login-bug");
    const managed = realpathSync(join(dataDir, "worktrees"));
    // The folder is a short random name, not the branch (docs/worktrees.md, "Położenie").
    expect(thread.cwd).toMatch(new RegExp(`^${join(managed, "repo")}/[0-9a-hjkmnp-tv-z]{6}$`));
    expect(thread.worktree).toMatchObject({ path: thread.cwd, baseRef: "main", repoRoot: realpathSync(repo) });
    await idle(thread.id);
    expect(readFileSync(join(thread.cwd, "worker-started.txt"), "utf8")).toBe(thread.cwd);
    expect(sh(thread.cwd, "rev-parse", "HEAD")).toBe(localMain);
    expect(sh(thread.cwd, "symbolic-ref", "--short", "HEAD")).toBe("wt/fix-the-login-bug");
    // The user's checkout is untouched.
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");

    const again = await newWorktreeThread("Fix the login bug", "feature/old");
    expect(again.worktree?.branch).toBe("wt/fix-the-login-bug-2");
    expect(again.cwd).toMatch(new RegExp(`^${join(managed, "repo")}/[0-9a-hjkmnp-tv-z]{6}$`));
    expect(again.cwd).not.toBe(thread.cwd);
    expect(again.worktree?.baseRef).toBe("feature/old");

    const listed = await gw.api.listGitRefs({ workspaceId: workspace.id });
    expect(listed.worktrees.map((w) => w.branch)).toEqual(["wt/fix-the-login-bug-2", "wt/fix-the-login-bug"]);

    // A previous worktree: a new thread works in the same directory.
    const reused = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId: thread.worktree!.id,
      })
    ).thread!;

    expect([reused.cwd, reused.worktree?.id]).toEqual([thread.cwd, thread.worktree!.id]);
    await idle(reused.id);

    const side = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        parentThreadId: thread.id,
        cwd: thread.cwd,
        provider: Provider.CODEX,
      })
    ).thread!;

    expect([side.cwd, side.worktree?.id]).toEqual([thread.cwd, thread.worktree!.id]);
    await idle(side.id);

    const checkout = (
      await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    expect([checkout.cwd, checkout.worktree]).toEqual([repo, undefined]);
  });

  test("first-message file mentions use the new, reused or inherited worktree directory", async () => {
    const initialMessage = "@README.md";

    const draft = {
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      initialMessage,
      initialMentions: [{ kind: MentionKind.FILE, name: "README.md", start: 0, end: initialMessage.length }],
    };

    const first = (
      await gw.api.createThread({ ...draft, workspaceMode: ui.WorkspaceMode.NEW_WORKTREE, baseRef: "main" })
    ).thread!;

    const reused = (
      await gw.api.createThread({
        ...draft,
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId: first.worktree!.id,
      })
    ).thread!;

    const side = (await gw.api.createThread({ ...draft, parentThreadId: first.id })).thread!;

    for (const thread of [first, reused, side]) {
      const turns = await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id)));
      expect(thread.cwd).toBe(first.cwd);
      expect(turns[0]?.input).toMatchObject({ mentions: [{ path: join(first.cwd, "README.md") }] });
    }
  });

  test("start from remote: the tracked branch's latest commit after a fetch, without tracking it", async () => {
    const remoteMain = commit(other, "remote.txt", "newer");
    sh(other, "push", "-q", "origin", "main");
    // A project override; the global scope keeps the prefix naming.
    const saved = await settings(project.id, { startFromRemote: true, branchNaming: ui.BranchNaming.TITLE });
    expect(saved.effective).toMatchObject({
      startFromRemote: true,
      branchPrefix: "wt",
      branchNaming: ui.BranchNaming.TITLE,
    });
    expect(saved.inherited?.branchNaming).toBe(ui.BranchNaming.PREFIX);

    const thread = await newWorktreeThread("Ship the remote change");
    expect(thread.worktree).toMatchObject({ branch: "ship-the-remote-change", baseRef: "origin/main" });
    expect(sh(thread.cwd, "rev-parse", "HEAD")).toBe(remoteMain);
    expect(sh(repo, "rev-parse", "main")).toBe(localMain);
    expect(Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: thread.cwd }).exitCode).not.toBe(
      0,
    );
    await settings(project.id, { startFromRemote: false, branchNaming: ui.BranchNaming.UNSPECIFIED });
  });

  test("semantic names: the thread starts at once on a provisional name, the model's type/slug replaces it", async () => {
    await settings("", { branchNaming: ui.BranchNaming.SEMANTIC, branchPrefix: "canopy" });
    generatedText = "`feat/Add dark mode`";
    const count = generated.length;
    const thread = await newWorktreeThread("Please add a dark mode toggle to settings");
    // Provisional: the first words and a random part (this worker has no provisional_branches: one attempt).
    expect(thread.worktree?.branch).toMatch(/^canopy\/please-add-a-[0-9a-hjkmnp-tv-z]{4}$/);

    const renamed = await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.worktree?.branch === "feat/add-dark-mode",
    );

    expect(renamed.thread?.cwd).toBe(thread.cwd);
    expect(sh(thread.cwd, "symbolic-ref", "--short", "HEAD")).toBe("feat/add-dark-mode");
    expect(generated.slice(count).some((g) => g.prompt.includes("Please add a dark mode toggle"))).toBe(true);

    // A reply that is not <type>/<slug> keeps the first name.
    generatedText = "Sure! Here is a name: dark-mode";
    const kept = await newWorktreeThread("Another dark mode pass");
    await eventually(
      async () => generated.filter((g) => g.prompt.includes("Another dark mode pass")).length,
      (n) => n > 0,
    );
    await Bun.sleep(300);
    expect((await gw.api.getThread({ threadId: kept.id })).thread?.worktree?.branch).toBe(kept.worktree!.branch);
    expect(kept.worktree?.branch).toMatch(/^canopy\/another-dark-mode-[0-9a-hjkmnp-tv-z]{4}$/);
  });

  test("remote bases prefer a differently named upstream, use same-named origin, and fall back when fetch fails", async () => {
    await settings(project.id, { startFromRemote: true, branchNaming: ui.BranchNaming.PREFIX });
    sh(repo, "remote", "add", "mirror", origin);
    sh(repo, "fetch", "-q", "mirror");
    sh(repo, "branch", "--set-upstream-to=mirror/main", "feature/old");
    const latest = commit(other, "latest.txt", "latest upstream");
    sh(other, "push", "-q", "origin", "main");
    const upstream = await newWorktreeThread("Tracked upstream", "feature/old");
    expect(upstream.worktree?.baseRef).toBe("mirror/main");
    expect(sh(upstream.cwd, "rev-parse", "HEAD")).toBe(latest);

    sh(repo, "branch", "release", localMain);
    sh(other, "push", "-q", "origin", "main:release");
    const sameName = await newWorktreeThread("Same named remote", "release");
    expect(sameName.worktree?.baseRef).toBe("origin/release");
    expect(sh(sameName.cwd, "rev-parse", "HEAD")).toBe(latest);

    sh(repo, "remote", "set-url", "mirror", join(dir, "missing-origin.git"));
    const fallback = await newWorktreeThread("Offline remote fallback", "feature/old");
    expect(fallback.worktree?.baseRef).toBe("feature/old");
    expect(sh(fallback.cwd, "rev-parse", "HEAD")).toBe(localMain);
    sh(repo, "remote", "remove", "mirror");
    await settings(project.id, { startFromRemote: false, branchNaming: ui.BranchNaming.UNSPECIFIED });
  });

  test("concurrent requests for the same branch get separate worktrees", async () => {
    await settings(project.id, { branchNaming: ui.BranchNaming.PREFIX });

    const [first, second] = await Promise.all([
      newWorktreeThread("Concurrent creation"),
      newWorktreeThread("Concurrent creation"),
    ]);

    expect(new Set([first.cwd, second.cwd]).size).toBe(2);
    expect(new Set([first.worktree?.branch, second.worktree?.branch]).size).toBe(2);
    expect(sh(first.cwd, "rev-parse", "HEAD")).toBe(localMain);
    expect(sh(second.cwd, "rev-parse", "HEAD")).toBe(localMain);
    await settings(project.id, { branchNaming: ui.BranchNaming.UNSPECIFIED });
  });

  test("branch naming preserves a published branch or a branch the agent has already changed", async () => {
    await settings(project.id, { branchNaming: ui.BranchNaming.PREFIX });
    const thread = await newWorktreeThread("Preserve this branch");
    sh(thread.cwd, "branch", "--set-upstream-to=origin/main");

    const rename = () =>
      host.handleCommand(
        create(CommandSchema, {
          commandId: Bun.randomUUIDv7(),
          kind: {
            case: "renameWorktreeBranch",
            value: { path: thread.cwd, fromBranch: thread.worktree!.branch, toBranch: "feat/generated-name" },
          },
        }),
      );

    expect(await rename()).toMatchObject({
      ok: true,
      worktree: { renamed: false, detail: "the branch already has an upstream" },
    });
    sh(thread.cwd, "branch", "--unset-upstream");
    sh(thread.cwd, "branch", "-m", "agent-chose-this");
    expect(await rename()).toMatchObject({
      ok: true,
      worktree: { renamed: false, detail: "the worktree is on another branch" },
    });
    expect(sh(thread.cwd, "symbolic-ref", "--short", "HEAD")).toBe("agent-chose-this");
    await settings(project.id, { branchNaming: ui.BranchNaming.UNSPECIFIED });
  });

  test("paths stay under the managed root or the configured absolute location", async () => {
    expect(await failure(settings("", { location: "relative/dir" }))).toContain("absolute");
    expect(await failure(settings("", { branchPrefix: "../x" }))).toContain("branch prefix");
    const location = join(dir, "custom-worktrees");
    await settings("", { location, branchNaming: ui.BranchNaming.PREFIX, branchPrefix: "loc" });
    const thread = await newWorktreeThread("Use the configured folder");
    expect(thread.cwd).toMatch(new RegExp(`^${join(realpathSync(location), "repo")}/[0-9a-hjkmnp-tv-z]{6}$`));
    await settings("", { location: undefined });

    const command = (kind: NonNullable<MessageInitShape<typeof CommandSchema>["kind"]>) =>
      host.handleCommand(create(CommandSchema, { commandId: Bun.randomUUIDv7(), kind }));

    expect(await command({ case: "createWorktree", value: { repoPath: repo, branch: "../../escape" } })).toMatchObject({
      ok: false,
      errorCode: "BAD_BRANCH",
    });
    expect(
      await command({ case: "createWorktree", value: { repoPath: repo, branch: "x", baseRef: "--upload-pack=evil" } }),
    ).toMatchObject({ ok: false, errorCode: "BAD_REF" });
    expect(
      await command({ case: "createWorktree", value: { repoPath: repo, branch: "x", location: "relative" } }),
    ).toMatchObject({ ok: false, errorCode: "LOCATION_NOT_ABSOLUTE" });
    // The user's checkout is outside every root: its branch is never renamed.
    expect(
      await command({
        case: "renameWorktreeBranch",
        value: { path: repo, fromBranch: "main", toBranch: "stolen" },
      }),
    ).toMatchObject({ ok: false, errorCode: "PATH_OUTSIDE_ROOT" });
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(existsSync(join(dir, "escape"))).toBe(false);
  });

  test("a symlinked repository folder cannot escape; a configured root may itself be a symlink", async () => {
    const location = join(dir, "containment");
    const outside = join(dir, "outside");
    mkdirSync(location);
    mkdirSync(outside);
    symlinkSync(outside, join(location, "repo"), "dir");
    await settings("", { location });
    expect(await failure(newWorktreeThread("Escaped worktree"))).toContain("outside its root");
    expect(readdirSync(outside)).toEqual([]);
    expect(
      Bun.spawnSync(["git", "show-ref", "--verify", "refs/heads/loc/escaped-worktree"], { cwd: repo }).exitCode,
    ).not.toBe(0);

    const alias = join(dir, "location-alias");
    symlinkSync(outside, alias, "dir");
    await settings("", { location: alias });
    const thread = await newWorktreeThread("Use an aliased root");
    expect(thread.cwd.startsWith(`${alias}/repo/`)).toBe(true);
    expect(realpathSync(thread.cwd).startsWith(`${outside}/repo/`)).toBe(true);
    await idle(thread.id);
    await settings("", { location: undefined });
  });

  test("invalid refs and a mismatched project fail before making a worktree; git receives literal argv", async () => {
    expect(await failure(newWorktreeThread("Missing ref", "missing/ref"))).toContain("not a branch or commit");
    const before = sh(repo, "for-each-ref", "--format=%(refname)", "refs/heads");
    const second = (await gw.api.createProject({ name: "Mismatch" })).project!;
    expect(
      await failure(
        gw.api.createThread({
          projectId: second.id,
          workspaceId: workspace.id,
          provider: Provider.CODEX,
          workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
          initialMessage: "Should not make a branch",
        }),
      ),
    ).toContain("workspace not found");
    expect(sh(repo, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(before);

    const literal = await host.handleCommand(
      create(CommandSchema, {
        commandId: Bun.randomUUIDv7(),
        kind: { case: "createWorktree", value: { repoPath: repo, branch: "safe/$(uname)", baseRef: "main" } },
      }),
    );

    expect(literal).toMatchObject({ ok: true, worktree: { branch: "safe/$(uname)" } });
    expect(sh(literal!.worktree!.path!, "symbolic-ref", "--short", "HEAD")).toBe("safe/$(uname)");
  });

  test("owner scoping: another owner's worktree, project or a foreign workspace are not found", async () => {
    const otherUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@x", "other")));
    const foreignProject = await gw.runtime.runPromise(GatewayStore.use((s) => s.createProject(otherUser, "Foreign")));

    const privateWorker = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Private", ownerUserId: otherUser })),
    );

    expect(await failure(gw.api.getWorktreeSettings({ workerId: privateWorker.workerId }))).toContain(
      "worker not found",
    );
    const mine = (await gw.api.listGitRefs({ workspaceId: workspace.id })).worktrees[0]!;

    const foreign = await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.insertWorktree({
          id: Bun.randomUUIDv7(),
          owner_user_id: otherUser,
          project_id: project.id,
          workspace_id: workspace.id,
          worker_id: workerId,
          repo_root: repo,
          path: join(dir, "foreign"),
          branch: "foreign",
          base_ref: "main",
          base_commit: "",
        }),
      ),
    );

    const existing = (worktreeId: string, projectId = project.id, workspaceId = workspace.id) =>
      gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId,
      });

    expect(await failure(existing(foreign.id))).toContain("worktree not found");
    expect(await failure(existing("not-a-uuid"))).toContain("worktree not found");
    expect((await gw.api.listGitRefs({ workspaceId: workspace.id })).worktrees.map((w) => w.id)).not.toContain(
      foreign.id,
    );
    expect(await failure(gw.api.getWorktreeSettings({ projectId: foreignProject.id, workerId: "" }))).toContain(
      "project not found",
    );

    // Another project of mine: its workspace does not take this project's worktree.
    const second = (await gw.api.createProject({ name: "Second" })).project!;
    const secondWs = (await gw.api.createWorkspace({ projectId: second.id, workerId, rootPath: other })).workspace!;
    expect(await failure(existing(mine.id, second.id, secondWs.id))).toContain("worktree not found");

    const anotherCheckout = (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: other }))
      .workspace!;

    expect((await gw.api.listGitRefs({ workspaceId: anotherCheckout.id })).worktrees).toEqual([]);
    expect(await failure(existing(mine.id, project.id, anotherCheckout.id))).toContain("worktree not found");
  });

  test("a worker without the capability: no refs, a clear error for a new worktree, the checkout still works", async () => {
    const old = (await gw.api.createProject({ name: "Old worker" })).project!;

    const oldWs = (await gw.api.createWorkspace({ projectId: old.id, workerId: gw.workerId, rootPath: "/repo" }))
      .workspace!;

    const refs = await gw.api.listGitRefs({ workspaceId: oldWs.id });
    expect(refs.supported).toBe(false);
    expect(refs.detail).toContain("does not support worktrees");
    expect((await gw.api.getOverview({})).workers.find((w) => w.id === gw.workerId)?.worktrees).toBe(false);

    expect(
      await failure(
        gw.api.createThread({
          projectId: old.id,
          workspaceId: oldWs.id,
          provider: Provider.CODEX,
          workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        }),
      ),
    ).toContain("does not support worktrees");
    const plain = await gw.api.createThread({ projectId: old.id, workspaceId: oldWs.id, provider: Provider.CODEX });
    expect(plain.thread?.cwd).toBe("/repo");
  });

  test("settings resolve field by field across all four scopes, reset overrides and reject stale versions", async () => {
    const scoped = (await gw.api.createProject({ name: "Settings scopes" })).project!;
    await settings("", { branchPrefix: "global", startFromRemote: false });
    await settings("", { branchPrefix: "computer", startFromRemote: true }, workerId);
    await settings(scoped.id, { branchPrefix: "project" });
    const exact = await gw.api.getWorktreeSettings({ projectId: scoped.id, workerId });
    expect(exact.effective).toMatchObject({ branchPrefix: "project", startFromRemote: true });
    expect(exact.settings?.branchPrefix).toBeUndefined();
    expect(exact.inheritedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "branchPrefix", projectId: scoped.id, workerId: "" }),
        expect.objectContaining({ field: "startFromRemote", projectId: "", workerId }),
      ]),
    );
    const saved = await settings(scoped.id, { branchPrefix: "exact", startFromRemote: false }, workerId);
    expect(saved.inherited).toMatchObject({ branchPrefix: "project", startFromRemote: true });
    expect(saved.effective).toMatchObject({ branchPrefix: "exact", startFromRemote: false });
    expect(
      await failure(
        gw.api.updateWorktreeSettings({
          projectId: scoped.id,
          workerId,
          expectedVersion: exact.version,
          settings: { branchPrefix: "stale" },
        }),
      ),
    ).toContain("changed elsewhere");

    const reset = await gw.api.updateWorktreeSettings({
      projectId: scoped.id,
      workerId,
      expectedVersion: saved.version,
      settings: {},
    });

    expect(reset.effective).toMatchObject({ branchPrefix: "project", startFromRemote: true });
    expect(await failure(settings(scoped.id, { defaultMode: ui.WorkspaceMode.EXISTING_WORKTREE }))).toContain(
      "default workspace",
    );
    expect(await failure(settings(scoped.id, { branchPrefix: "bad..prefix" }))).toContain("branch prefix");
  });

  test("linked computer worktrees are explicitly refused before routing to an older home", async () => {
    const nodeId = "ab".repeat(32);
    const remoteWorkspace = qualifyId(workspace.id, nodeId);
    expect(await failure(gw.api.listGitRefs({ workspaceId: remoteWorkspace }))).toContain(
      "Worktrees on linked computers are not supported yet",
    );

    for (const mode of [
      ui.WorkspaceMode.NEW_WORKTREE,
      ui.WorkspaceMode.EXISTING_WORKTREE,
      ui.WorkspaceMode.INHERIT_PARENT,
    ]) {
      expect(
        await failure(
          gw.api.createThread({
            projectId: qualifyId(project.id, nodeId),
            workspaceId: remoteWorkspace,
            provider: Provider.CODEX,
            workspaceMode: mode,
          }),
        ),
      ).toContain("Worktrees on linked computers are not supported yet");
    }
  });
});
