import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MentionKind, Provider, ui } from "@canopy/contracts";
import { mentionPlaceholder } from "@canopy/domain";
import { create } from "@bufbuild/protobuf";
import { Effect } from "effect";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { eventually, failure, watchUntil } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("thread branch selection over the worker link", () => {
  const dir = tempDir("canopy-thread-branches-");
  const capabilities = ["git_heads", "git_branch_switch_v1"];
  let f: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  const snapshotOf = async (threadId: string) => {
    const updates = await watchUntil(f.gw.api, threadId, (updates) =>
      updates.some((u) => u.change.case === "snapshot"),
    );

    for (const update of updates) if (update.change.case === "snapshot") return update.change.value;
    throw new Error("Missing thread snapshot");
  };

  test("lists the thread's checkout, switches live, records the notice and tells the next agent", async () => {
    const thread = await f.tree();
    git(f.repo, "branch", "feature/selected");
    const listed = await f.gw.api.listThreadBranches({ threadId: thread.id });
    expect(listed.supported).toBe(true);
    expect(listed.refs?.currentBranch).toBe(thread.worktree!.branch);
    expect(listed.refs?.refs.some((ref) => ref.name === "feature/selected")).toBe(true);

    const live = watchUntil(f.gw.api, thread.id, (updates) =>
      updates.some(
        (update) => update.change.case === "thread" && update.change.value.worktree?.branch === "feature/selected",
      ),
    );

    const switched = await f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "feature/selected" });
    expect(switched.thread?.worktree?.branch).toBe("feature/selected");
    expect((await live).length).toBeGreaterThan(0);
    expect(git(thread.cwd, "branch", "--show-current")).toBe("feature/selected");
    expect(git(f.repo, "branch", "--show-current")).toBe("main");
    const snapshot = await snapshotOf(thread.id);
    expect(snapshot.notices.find((entry) => entry.notice?.code === "branch_switched")?.notice?.message).toBe(
      "Branch switched to feature/selected by you",
    );
    const spec = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.thread(thread.id)));
    expect(spec.settings.branchNote).toContain("feature/selected");
    f.disconnect();
    await eventually(
      () => f.gw.api.getOverview({}),
      (o) => !o.workers.find((w) => w.id === f.workerId)?.online,
    );
    const mentioned = { kind: MentionKind.FILE, name: "README.md", label: "README.md" };
    const token = mentionPlaceholder(mentioned);
    const text = `Check ${token}`;

    await f.gw.api.sendMessage({
      threadId: thread.id,
      text,
      clientRequestId: "branch-context",
      mentions: [{ ...mentioned, start: 6, end: text.length }],
    });

    const commands = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(f.workerId)));

    const command = commands.find(
      ({ command: c }) => c.kind.case === "startTurn" && c.kind.value.thread?.threadId === thread.id,
    )?.command;

    expect(command?.kind.case).toBe("startTurn");

    if (command?.kind.case === "startTurn") {
      expect(command.kind.value.input?.text).toContain("The user switched this checkout to branch feature/selected");
      const input = command.kind.value.input!;
      expect(input.text.slice(input.mentions[0]!.start, input.mentions[0]!.end)).toContain("README.md");

      const turn = await f.gw.runtime.runPromise(
        GatewayStore.use((s) => s.turnByClientRequest(thread.id, "branch-context")),
      );

      expect(turn?.input.text).toBe(input.text);
      expect(turn?.input.note).toContain("feature/selected");
      expect(turn?.input.message).toBe(text);
    }

    expect(
      (await f.gw.runtime.runPromise(GatewayStore.use((s) => s.thread(thread.id)))).settings.branchNote,
    ).toBeUndefined();
    await f.connect();
    await eventually(
      () => snapshotOf(thread.id),
      (s) => s.turns.every((t) => t.status !== "queued" && t.status !== "running"),
    );
  });

  test("creates a tracking branch from an existing remote ref without fetching", async () => {
    const thread = await f.tree();
    git(f.repo, "update-ref", "refs/remotes/origin/remote-choice", "HEAD");

    const switched = await f.gw.api.switchThreadBranch({
      threadId: thread.id,
      branch: "origin/remote-choice",
      remote: true,
    });

    expect(switched.thread?.worktree?.branch).toBe("remote-choice");
    expect(git(thread.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/remote-choice");
  });

  test("a delayed switch command expires before it can change HEAD", async () => {
    const thread = await f.tree();
    const original = git(thread.cwd, "branch", "--show-current");

    const result = await f.command({
      commandId: Bun.randomUUIDv7(),
      kind: {
        case: "switchThreadBranch",
        value: {
          threadId: thread.id,
          cwd: thread.cwd,
          branch: "feature/selected",
          expiresAtMs: BigInt(Date.now() - 1),
        },
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "SWITCH_EXPIRED" });
    expect(git(thread.cwd, "branch", "--show-current")).toBe(original);
  });

  test("refuses dirty trees and a branch used in another worktree, leaving HEAD and files intact", async () => {
    const thread = await f.tree();
    const original = git(thread.cwd, "branch", "--show-current");
    const dirty = join(thread.cwd, "uncommitted.txt");
    writeFileSync(dirty, "keep this");
    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "feature/selected" }))).toContain(
      "uncommitted changes",
    );
    rmSync(dirty);
    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "main" }))).toMatch(
      /worktree|already checked out/,
    );
    expect(git(thread.cwd, "branch", "--show-current")).toBe(original);
    expect((await snapshotOf(thread.id)).notices).toHaveLength(0);
    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "--detach" }))).toContain(
      "existing branch",
    );
  });

  test("gateway refuses a running or queued turn of any thread sharing the checkout", async () => {
    const thread = await f.tree();

    const side = (
      await f.gw.api.createThread({
        parentThreadId: thread.id,
        projectId: thread.projectId,
        workspaceId: thread.workspaceId,
        provider: Provider.CODEX,
      })
    ).thread!;

    await eventually(
      () => f.gw.api.getThread({ threadId: side.id }),
      (r) => r.thread?.status === "idle",
    );
    rmSync(join(thread.cwd, "worker-started.txt"));

    const queued = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueTurn({
          threadId: side.id,
          userId: f.gw.userId,
          clientRequestId: "branch-switch-busy",
          text: "stay queued",
        }),
      ),
    );

    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "remote-choice" }))).toContain(
      "using this directory",
    );
    await f.sql((sql) => sql`UPDATE turns SET status='running' WHERE id=${queued.id}::uuid`);
    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "remote-choice" }))).toContain(
      "using this directory",
    );
    await f.gw.runtime.runPromise(GatewayStore.use((s) => s.failTurn(queued.id, "fixture finished", "platform")));
  });

  test("owner scoping rejects another owner's thread before contacting its worker", async () => {
    const foreign = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        Effect.gen(function* () {
          const owner = yield* s.ensureUser("branches-other@localhost", "Other");
          const project = yield* s.createProject(owner, "Private");
          const worker = yield* s.addWorker({ name: "Private", ownerUserId: owner });

          const workspace = yield* s.createWorkspace({
            projectId: project.id,
            workerId: worker.workerId,
            rootPath: f.repo,
            label: "",
          });

          return yield* s.createThread(
            owner,
            create(ui.CreateThreadRequestSchema, {
              projectId: project.id,
              workspaceId: workspace.id,
              provider: Provider.CODEX,
            }),
          );
        }),
      ),
    );

    expect(await failure(f.gw.api.listThreadBranches({ threadId: foreign.id }))).toContain("unavailable");
    expect(await failure(f.gw.api.switchThreadBranch({ threadId: foreign.id, branch: "main" }))).toContain(
      "unavailable",
    );
  });

  test("a checkout reached through another workspace alias shares its lock, HEAD and notice", async () => {
    const thread = await f.tree();
    const alias = join(dir, "checkout-alias");
    symlinkSync(thread.cwd, alias, "dir");

    const workspace = (
      await f.gw.api.createWorkspace({ projectId: f.project.id, workerId: f.workerId, rootPath: alias })
    ).workspace!;

    const shared = (
      await f.gw.api.createThread({
        projectId: f.project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.CHECKOUT,
      })
    ).thread!;

    await eventually(
      () => f.gw.api.getThread({ threadId: shared.id }),
      (r) => r.thread?.status === "idle",
    );
    rmSync(join(thread.cwd, "worker-started.txt"));

    const queued = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueTurn({
          threadId: shared.id,
          userId: f.gw.userId,
          clientRequestId: "alias-busy",
          text: "queued",
        }),
      ),
    );

    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "remote-choice" }))).toContain(
      "using this directory",
    );
    await f.gw.runtime.runPromise(GatewayStore.use((s) => s.failTurn(queued.id, "fixture finished", "platform")));
    git(f.repo, "branch", "alias-choice");
    await f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "alias-choice" });
    const snapshot = await snapshotOf(shared.id);
    expect(snapshot.thread?.checkoutHead?.branch).toBe("alias-choice");
    expect(snapshot.notices.find((n) => n.notice?.code === "branch_switched")?.notice?.message).toBe(
      "Branch switched to alias-choice by you",
    );
  });

  test("an older worker keeps readable HEAD metadata but never receives a switch command", async () => {
    const thread = await f.tree();
    capabilities.splice(capabilities.indexOf("git_branch_switch_v1"), 1);
    f.disconnect();
    await f.connect();
    const listed = await f.gw.api.listThreadBranches({ threadId: thread.id });
    expect(listed.supported).toBe(false);
    expect(listed.detail).toContain("Update this computer");
    expect(await failure(f.gw.api.switchThreadBranch({ threadId: thread.id, branch: "main" }))).toContain(
      "Update this computer",
    );
    expect((await f.gw.api.getOverview({})).workers.find((w) => w.id === f.workerId)?.branchSwitch).toBe(false);
    expect((await f.gw.api.getThread({ threadId: thread.id })).thread?.worktree?.branch).toBe(thread.worktree?.branch);
  });
});
