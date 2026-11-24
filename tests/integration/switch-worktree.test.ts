import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { AgentBusArgs } from "@canopy/domain";
import { THREAD_WORKTREE_SWITCH_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { Schema } from "effect";
import { eventually } from "./support/gateway.ts";
import { followThread } from "./support/thread-watch.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("switch_worktree from a running Codex turn", () => {
  const dir = tempDir("canopy-switch-worktree-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  const previousTrace = process.env["INSTANCE_TRACE"];
  const report = "REPORT_THREAD_CWD";
  const destination = Schema.fromJsonString(Schema.Struct({ cwd: Schema.String, branch: Schema.String }));

  const capabilities = [
    THREAD_WORKTREE_SWITCH_CAPABILITY,
    "git_worktree_discovery",
    "git_heads",
    "git_status_v1",
    "thread_diff_v1",
  ];

  beforeAll(async () => {
    process.env["INSTANCE_TRACE"] = join(dir, "trace.jsonl");
    f = await worktreeFixture(dir, {
      capabilities,
      codexFixture: new URL("./fixtures/instance-codex.ts", import.meta.url),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await f?.close();
    } finally {
      if (previousTrace === undefined) delete process.env["INSTANCE_TRACE"];
      else process.env["INSTANCE_TRACE"] = previousTrace;
    }
  });

  async function newThread() {
    const { thread } = await f.gw.api.createThread({
      projectId: f.project.id,
      workspaceId: f.workspace.id,
      provider: Provider.CODEX,
      workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
      permissionMode: PermissionMode.FULL_AUTO,
      baseRef: "main",
    });

    await f.settled(thread!);

    return thread!;
  }

  const turns = (threadId: string) => f.gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(threadId)));

  async function waitTurn(threadId: string, turnId: string, status: "running" | "completed") {
    const row = await eventually(
      async () => (await turns(threadId)).find((turn) => turn.id === turnId),
      (turn) => turn?.status === status || turn?.status === "failed",
      10_000,
    );

    expect(row).toMatchObject({ id: turnId, status });
  }

  const send = async (threadId: string, text: string, permissionMode = PermissionMode.UNSPECIFIED) =>
    (await f.gw.api.sendMessage({ threadId, text, permissionMode, clientRequestId: Bun.randomUUIDv7() })).turn!.id;

  async function switchFrom(
    threadId: string,
    args: AgentBusArgs["switch_worktree"],
    permissionMode = PermissionMode.UNSPECIFIED,
  ) {
    // Release the fake model to call the worker's real, thread-scoped MCP only once its turn has authority.
    const gate = Bun.randomUUIDv7();

    const turnId = await send(
      threadId,
      `HOLD:${gate}\nTOOL:switch_worktree ARGS:${JSON.stringify(args)}`,
      permissionMode,
    );

    try {
      await waitTurn(threadId, turnId, "running");
    } finally {
      writeFileSync(join(dir, `release-${gate}`), "");
    }

    await waitTurn(threadId, turnId, "completed");
    const { items } = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId)));
    const call = items.find((entry) => entry.turnId === turnId && entry.item?.content.case === "agentBusCall");

    if (call?.item?.content.case !== "agentBusCall") throw new Error(`Missing switch_worktree call in turn ${turnId}`);

    return { turnId, call: call.item.content.value };
  }

  test("fork moves from the source HEAD, publishes live Git changes and resumes once in its sandbox", async () => {
    const source = await newThread();
    const base = commit(source.cwd, "source.txt", "source-only commit\n");
    expect(base).not.toBe(git(f.repo, "rev-parse", "HEAD"));
    const fromTurn = await send(source.id, report);
    await waitTurn(source.id, fromTurn, "completed");
    const { thread: fork } = await f.gw.api.createThread({ forkThreadId: source.id, forkAtTurnId: fromTurn });
    await f.settled(fork!);
    const threadId = fork!.id;
    expect(fork).toMatchObject({
      cwd: source.cwd,
      worktree: { id: source.worktree!.id },
      forkSourceThreadId: source.id,
    });
    writeFileSync(join(source.cwd, "parent-only.txt"), "pending source edit\n");
    expect((await f.gw.api.listThreadDiff({ threadId })).files.map((file) => file.path)).toEqual(["parent-only.txt"]);
    const branch = "feature/parallel-work";
    const args = { branch, continuation: report };
    const abort = new AbortController();
    const watch = await followThread(f.gw.api.watchThread({ threadId }, { signal: abort.signal }), abort);

    try {
      expect(watch.state.thread?.cwd).toBe(source.cwd);
      const { turnId, call } = await switchFrom(threadId, args);
      expect(call).toMatchObject({ toolName: "switch_worktree", isError: false });
      const placed = Schema.decodeSync(destination)(call.resultJson);
      expect(placed.branch).toBe(branch);
      expect(placed.cwd).not.toBe(source.cwd);
      expect(git(placed.cwd, "rev-parse", "HEAD")).toBe(base);
      expect(git(placed.cwd, "branch", "--show-current")).toBe(branch);
      await watch.until((s) => s.thread?.cwd === placed.cwd && s.thread.worktree?.branch === branch);
      expect(watch.state.thread).toMatchObject({ id: threadId, permissionMode: PermissionMode.FULL_AUTO });
      expect((await f.gw.api.getThread({ threadId: source.id })).thread).toMatchObject({
        cwd: source.cwd,
        worktree: { id: source.worktree!.id, branch: source.worktree!.branch },
      });

      writeFileSync(join(placed.cwd, "parallel-only.txt"), "new checkout\n");
      expect((await f.gw.api.getThreadGitStatus({ threadId })).status).toMatchObject({ branch, files: 1, added: 1 });
      expect((await f.gw.api.listThreadDiff({ threadId })).files.map((file) => file.path)).toEqual([
        "parallel-only.txt",
      ]);
      expect((await f.gw.api.listThreadDiff({ threadId: source.id })).files.map((file) => file.path)).toEqual([
        "parent-only.txt",
      ]);

      await watch.until((s) => s.turns.some((t) => t.trigger === "agent_bus" && t.status === "completed"));
      const continued = watch.state.turns.find((turn) => turn.trigger === "agent_bus")!;
      expect(continued).toMatchObject({ messageText: report, permissionMode: PermissionMode.FULL_AUTO });

      const native = watch.state.items.find(
        (i) => i.turnId === continued.id && i.item?.content.case === "agentMessage",
      );

      expect(native?.item?.content).toMatchObject({
        case: "agentMessage",
        value: { text: JSON.stringify({ cwd: placed.cwd, approval: "never", sandbox: "workspaceWrite" }) },
      });

      const [record] = await f.sql(
        (sql) => sql<{ id: string }>`SELECT id FROM agent_bus_calls
        WHERE source_thread_id=${threadId}::uuid AND source_turn_id=${turnId}::uuid AND tool='switch_worktree'`,
      );

      const before = git(f.repo, "worktree", "list", "--porcelain");
      const replay = await f.callTool(threadId, args, record!.id, { turnId, toolName: "switch_worktree" });
      expect(replay.isError).toBe(false);
      expect(JSON.parse(replay.resultJson)).toEqual(JSON.parse(call.resultJson));
      expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
      expect((await turns(threadId)).filter((turn) => turn.trigger === "agent_bus").map((turn) => turn.id)).toEqual([
        continued.id,
      ]);
      // The last entry is a barrier for this whole worker report, including the two stale entries.
      f.send({
        case: "gitHeads",
        value: {
          heads: [
            { threadIds: [threadId], branch: "stale-source", cwd: source.cwd },
            { threadIds: [threadId], branch: "legacy-source" },
            { threadIds: [source.id], branch: "source-advanced", cwd: source.cwd },
          ],
        },
      });
      await eventually(
        () => f.gw.api.getThread({ threadId: source.id }),
        (r) => r.thread?.worktree?.branch === "source-advanced",
      );
      expect((await f.gw.api.getThread({ threadId })).thread?.worktree?.branch).toBe(branch);
    } finally {
      await watch.close();
    }
  }, 60_000);

  test("adopts a manually registered checkout, rejects foreign paths, and returns to the primary checkout", async () => {
    const thread = await newThread();
    const path = join(dir, "manual checkout");
    const branch = "manual-topic";
    git(f.repo, "worktree", "add", "-qb", branch, path);

    const adopted = await switchFrom(thread.id, { path });
    expect(adopted.call.isError).toBe(false);
    expect(Schema.decodeSync(destination)(adopted.call.resultJson)).toEqual({ cwd: path, branch });
    const current = async () => (await f.gw.api.getThread({ threadId: thread.id })).thread!;
    const manual = await current();
    expect(manual).toMatchObject({ cwd: path, worktree: { path, branch, external: true } });

    const foreign = join(dir, "other repository");
    git(dir, "clone", "-q", f.repo, foreign);
    const otherTree = join(dir, "other registered worktree");
    git(foreign, "worktree", "add", "-qb", "other-topic", otherTree);
    const nested = join(path, "nested");
    mkdirSync(nested);
    const before = git(f.repo, "worktree", "list", "--porcelain");

    for (const unsafe of [otherTree, nested]) {
      expect((await switchFrom(thread.id, { path: unsafe })).call.isError).toBe(true);
      expect(await current()).toMatchObject({ cwd: path, worktree: { id: manual.worktree!.id } });
    }

    expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);

    const primary = await switchFrom(thread.id, { path: f.repo, continuation: report }, PermissionMode.ASK);
    expect(primary.call.isError).toBe(false);
    expect(Schema.decodeSync(destination)(primary.call.resultJson)).toEqual({ cwd: f.repo, branch: "main" });
    const checkout = await current();
    expect(checkout).toMatchObject({ id: thread.id, cwd: f.repo });
    expect(checkout.worktree).toBeUndefined();

    const continued = await eventually(
      async () => (await turns(thread.id)).find((turn) => turn.trigger === "agent_bus"),
      (turn) => turn?.status === "completed",
    );

    expect(continued?.permission_mode).toBe("ASK");
  }, 60_000);
  test("a worker downgrade fences a switched session until a compatible worker reconnects", async () => {
    const source = await newThread();
    const placed = await switchFrom(source.id, { branch: "topic/reconnect" });
    expect(placed.call.isError).toBe(false);
    const { cwd } = Schema.decodeSync(destination)(placed.call.resultJson);
    capabilities.splice(capabilities.indexOf(THREAD_WORKTREE_SWITCH_CAPABILITY), 1);

    try {
      await f.restart();
      const denied = await send(source.id, report);

      const result = await eventually(
        async () => (await turns(source.id)).find((row) => row.id === denied),
        (row) => row?.status === "failed",
      );

      expect(result?.error_code).toBe("WORKTREE_SWITCH_UNSUPPORTED");
    } finally {
      capabilities.push(THREAD_WORKTREE_SWITCH_CAPABILITY);
      await f.restart();
    }

    const resumed = await send(source.id, report);
    await waitTurn(source.id, resumed, "completed");
    const { items } = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(source.id)));
    const reply = items.find((entry) => entry.turnId === resumed && entry.item?.content.case === "agentMessage");
    expect(reply?.item?.content).toMatchObject({
      case: "agentMessage",
      value: { text: JSON.stringify({ cwd, approval: "never", sandbox: "workspaceWrite" }) },
    });
  }, 60_000);
});
