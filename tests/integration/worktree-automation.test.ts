import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { eventually, failure } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";
import type { JsonObject } from "@canopy/domain";
import { qualifyId } from "@canopy/domain/computers";
import type { ModelReply } from "../../apps/gateway/src/bots/types.ts";

describe.skipIf(!dockerAvailable)("automation worktrees over gRPC", () => {
  const dir = tempDir("canopy-worktree-automation-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  let botArgs: JsonObject = {};
  let botCallPending = false;
  beforeAll(async () => {
    f = await worktreeFixture(dir, {
      botModel: async (): Promise<ModelReply> => {
        if (!botCallPending) return { text: "Started", calls: [] };
        botCallPending = false;

        return { text: "", calls: [{ id: Bun.randomUUIDv7(), name: "start_thread", arguments: botArgs }] };
      },
    });
    f.gw.core.bots.start();
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  const spawn = async (parent: ui.Thread, extra: JsonObject = {}, callId?: string) => {
    const result = await f.callTool(
      parent.id,
      { title: "Child", prompt: "Code task", notify: false, ...extra },
      callId,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.resultJson) as { thread_id: string };

    return (await f.gw.api.getThread({ threadId: parsed.thread_id })).thread!;
  };

  test("spawn inherits by default, can isolate, use checkout, and replay the same call without another worktree", async () => {
    const parent = await f.tree();
    await f.settings({ defaultMode: ui.WorkspaceMode.NEW_WORKTREE });
    const inherited = await spawn(parent);
    expect([inherited.cwd, inherited.worktree?.id, inherited.parentThreadId]).toEqual([
      parent.cwd,
      parent.worktree!.id,
      parent.id,
    ]);
    const id = Bun.randomUUIDv7();
    const isolated = await spawn(parent, { workspace_mode: "new_worktree", base_ref: "main" }, id);
    expect(isolated.worktree?.id).not.toBe(parent.worktree!.id);
    expect(git(isolated.cwd, "rev-parse", "--show-toplevel")).toBe(isolated.cwd);
    expect((await spawn(parent, { workspace_mode: "new_worktree" }, id)).id).toBe(isolated.id);
    const checkout = await spawn(parent, { workspace_mode: "checkout" });
    expect([checkout.cwd, checkout.worktree]).toEqual([f.repo, undefined]);
    const scoped = await spawn(parent, { workspace_mode: "default" });
    expect(scoped.worktree?.id).not.toBe(parent.worktree!.id);
    await f.settings({ defaultMode: ui.WorkspaceMode.CHECKOUT });
  });

  test("failed worktree creation returns safe reasons and replays the refusal without creating a child", async () => {
    const parent = await f.tree();

    const failures = [
      ["GIT_TIMEOUT", "Git timed out while creating the worktree."],
      ["legacy-limit", "Git exceeded its time or output limit while creating the worktree."],
      ["GIT_OUTPUT_LIMIT", "Git exceeded its output limit while creating the worktree."],
      ["GIT_BUSY", "Git is busy on the worker. Try creating the worktree again shortly."],
      ["GIT_UNAVAILABLE", "Git could not start on the worker. Check the Git installation."],
      ["WORKTREE_CHECKOUT_FAILED", "Git could not check out the worktree. Check the Git settings and filters."],
      [
        "WORKTREE_FAILED",
        "Git could not create the worktree. Canopy could not finish cleanup. Check the worktree and branch before retrying.",
      ],
      ["constructor", "Could not create a worktree."],
    ] as const;

    const handle = f.host.handleCommand.bind(f.host);
    const attempts: string[] = [];

    const worker = spyOn(f.host, "handleCommand").mockImplementation(async (command) => {
      if (command.kind.case !== "createWorktree") return handle(command);
      const fixture = command.kind.value.baseRef;
      attempts.push(fixture);

      const cleanup =
        fixture === "WORKTREE_FAILED"
          ? " Canopy could not finish cleanup. Check the worktree and branch before retrying."
          : "";

      return {
        commandId: command.commandId,
        ok: false,
        errorCode: fixture === "legacy-limit" ? "GIT_TIMEOUT" : fixture,
        errorMessage:
          fixture === "legacy-limit"
            ? "git exceeded its time or output limit"
            : `fatal: cannot read /private/worker/repo during checkout${cleanup}`,
      };
    });

    try {
      for (const [code, reason] of failures) {
        const args = { title: "Child", prompt: "Code task", workspace_mode: "new_worktree", base_ref: code };
        const callId = Bun.randomUUIDv7();
        const result = await f.callTool(parent.id, args, callId);
        expect(result).toMatchObject({ isError: true, content: reason, resultJson: JSON.stringify({ error: reason }) });
        expect(await f.callTool(parent.id, args, callId)).toEqual(result);
      }

      expect(attempts).toEqual(failures.map(([code]) => code));
      expect(
        await f.sql((sql) => sql`SELECT id FROM threads WHERE parent_thread_id = ${parent.id}::uuid`),
      ).toHaveLength(0);
    } finally {
      worker.mockRestore();
    }
  });

  test("spawn reports an unconfirmed worktree when the gateway's worker deadline expires", async () => {
    const parent = await f.tree();
    const link = f.gw.core.link.connections.get(f.workerId)!;
    const send = link.sendCommand.bind(link);
    const handle = f.host.handleCommand.bind(f.host);

    const worker = spyOn(f.host, "handleCommand").mockImplementation((command) =>
      command.kind.case === "createWorktree" ? Promise.resolve(undefined) : handle(command),
    );

    const gateway = spyOn(link, "sendCommand").mockImplementation((kind, timeout, ...rest) =>
      send(kind, kind.case === "createWorktree" ? 50 : timeout, ...rest),
    );

    try {
      const result = await f.callTool(parent.id, {
        title: "Child",
        prompt: "Code task",
        workspace_mode: "new_worktree",
      });

      expect(result).toMatchObject({
        isError: true,
        content: "The worker did not confirm worktree creation in time. Check the worktree and branch before retrying.",
      });
    } finally {
      gateway.mockRestore();
      worker.mockRestore();
    }
  });

  const schedule = async (spec: MessageInitShape<typeof ui.NewThreadScheduleSchema>) =>
    (
      await f.gw.api.createSchedule({
        target: "new_thread",
        prompt: "Scheduled code task",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
        newThread: {
          projectId: f.project.id,
          placement: "specific",
          workspaceId: f.workspace.id,
          provider: Provider.CODEX,
          ...spec,
        },
      })
    ).schedule!;

  const fire = async (s: ui.Schedule) => {
    await f.gw.core.scheduler.tick(timestampDate(s.nextRunAt!));
    const current = (await f.gw.api.listSchedules({ includeFinished: true })).schedules.find((r) => r.id === s.id)!;
    expect(current.runs).toBe(1);

    return (await f.gw.api.getThread({ threadId: current.recentRuns[0]!.threadId })).thread!;
  };

  test("schedule uses scoped default at run time, explicit checkout and source worktree inheritance", async () => {
    const s = await schedule({});
    await f.settings({ defaultMode: ui.WorkspaceMode.NEW_WORKTREE });
    const isolated = await fire(s);
    expect(isolated.worktree?.path).toBe(isolated.cwd);
    expect(isolated.scheduleId).toBe(s.id);

    const inherited = await fire(
      await schedule({ workspaceMode: ui.WorkspaceMode.INHERIT_PARENT, parentThreadId: isolated.id }),
    );

    expect([inherited.cwd, inherited.worktree?.id, inherited.parentThreadId]).toEqual([
      isolated.cwd,
      isolated.worktree!.id,
      "",
    ]);
    const checkout = await fire(await schedule({ workspaceMode: ui.WorkspaceMode.CHECKOUT }));
    expect([checkout.cwd, checkout.worktree]).toEqual([f.repo, undefined]);
    await f.settings({ defaultMode: ui.WorkspaceMode.CHECKOUT });
  });

  test("a new-worktree schedule waits while offline and fires once after reconnect", async () => {
    const s = await schedule({ workspaceMode: ui.WorkspaceMode.NEW_WORKTREE });
    f.disconnect();
    await eventually(
      () => f.gw.api.getOverview({}),
      (o) => !o.workers.find((w) => w.id === f.workerId)?.online,
    );
    const now = timestampDate(s.nextRunAt!);
    await f.gw.core.scheduler.tick(now);
    expect((await f.gw.api.listSchedules({})).schedules.find((r) => r.id === s.id)?.runs).toBe(0);
    await f.connect();
    await f.gw.core.scheduler.tick(new Date(now.getTime() + 61_000));
    const current = (await f.gw.api.listSchedules({ includeFinished: true })).schedules.find((r) => r.id === s.id)!;
    expect(current.runs).toBe(1);
    expect(current.recentRuns).toHaveLength(1);
    expect((await f.gw.api.getThread({ threadId: current.recentRuns[0]!.threadId })).thread?.worktree).toBeDefined();
  });

  test("bots use scoped defaults and explicit inheritance for code tasks", async () => {
    await f.gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "automation-bot",
      create: true,
      label: "Automation",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
    });
    await f.gw.api.setInstanceModels({
      harness: Provider.CODEX,
      id: "automation-bot",
      models: { custom: ["gpt-6.1-sol"] },
    });

    const bot = (
      await f.gw.api.createBot({
        configuration: {
          name: "Automation",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "automation-bot",
          model: "gpt-6.1-sol",
          approvalPolicy: "full_auto",
        },
        clientRequestId: Bun.randomUUIDv7(),
      })
    ).bot!;

    const runBot = async (extra: JsonObject) => {
      botArgs = {
        project_id: f.project.id,
        workspace_id: f.workspace.id,
        provider: "codex",
        provider_instance: "native",
        model: "gpt-6.1-sol",
        prompt: "Code task",
        ...extra,
      };
      const before = new Set((await f.gw.api.listThreads({ projectId: f.project.id })).threads.map((t) => t.id));
      botCallPending = true;
      await f.gw.api.sendBotMessage({ botId: bot.id, text: "Run code", clientRequestId: Bun.randomUUIDv7() });

      const listed = await eventually(
        () => f.gw.api.listThreads({ projectId: f.project.id }),
        (r) => r.threads.some((t) => !before.has(t.id)),
      );

      await eventually(
        () => f.gw.core.bots.run((s) => s.conversation(f.gw.userId, bot.id)),
        (r) => !r.working,
      );

      return listed.threads.find((t) => !before.has(t.id))!;
    };

    await f.settings({ defaultMode: ui.WorkspaceMode.NEW_WORKTREE });
    const isolated = await runBot({});
    await f.settled(isolated);
    expect(readFileSync(join(isolated.cwd, "worker-started.txt"), "utf8")).toBe(isolated.cwd);
    const inherited = await runBot({ workspace_mode: "inherit_parent", parent_thread_id: isolated.id });
    expect([inherited.cwd, inherited.worktree?.id]).toEqual([isolated.cwd, isolated.worktree!.id]);
    const checkout = await runBot({ workspace_mode: "checkout" });
    expect([checkout.cwd, checkout.worktree]).toEqual([f.repo, undefined]);
    await f.settings({ defaultMode: ui.WorkspaceMode.CHECKOUT });
  });

  test("automation trees participate in deleted-thread cleanup and foreign source threads are refused", async () => {
    const parent = await f.tree();
    const child = await spawn(parent, { workspace_mode: "new_worktree" });
    await f.settled(child);
    expect((await f.entry(child.worktree!.id)).status?.dirtyFiles).toBe(1);
    rmSync(join(child.cwd, "worker-started.txt"));
    await f.gw.api.deleteThread({ threadId: child.id });
    await f.settings({ cleanupDeletedThreads: true });
    expect(await f.entry(child.worktree!.id)).toMatchObject({
      wouldRemove: true,
      confirmationRequired: false,
      status: { dirtyFiles: 0 },
    });
    // A preview must notice external edits in both directions, even immediately after another scan.
    const localChange = join(child.cwd, "local-change.txt");
    writeFileSync(localChange, "Left by automation");
    expect(await f.entry(child.worktree!.id)).toMatchObject({
      wouldRemove: true,
      confirmationRequired: true,
      detail: "All threads deleted",
      status: { dirtyFiles: 1 },
    });
    rmSync(localChange);
    expect(await f.entry(child.worktree!.id)).toMatchObject({
      wouldRemove: true,
      confirmationRequired: false,
      status: { dirtyFiles: 0 },
    });
    writeFileSync(localChange, "Discard after every sharing thread is deleted");
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === child.worktree!.id)?.removed).toBe(true);
    const foreign = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("foreign@x", "Foreign")));
    const foreignProject = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.createProject(foreign, "Foreign")));

    const foreignWorker = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Foreign", ownerUserId: foreign })),
    );

    const foreignWorkspace = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.createWorkspace({
          projectId: foreignProject.id,
          workerId: foreignWorker.workerId,
          rootPath: f.repo,
          label: "",
        }),
      ),
    );

    const foreignThread = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.createThread(
          foreign,
          create(ui.CreateThreadRequestSchema, {
            projectId: foreignProject.id,
            workspaceId: foreignWorkspace.id,
            provider: Provider.CODEX,
          }),
        ),
      ),
    );

    expect(
      await failure(schedule({ workspaceMode: ui.WorkspaceMode.INHERIT_PARENT, parentThreadId: foreignThread.id })),
    ).toContain("parent thread must belong to this project and workspace");
    expect((await f.callTool(foreignThread.id, { title: "Foreign", prompt: "Code task" })).isError).toBe(true);
  });

  test("settled scheduled threads can be cleaned up and unknown linked computers are refused", async () => {
    const thread = await fire(await schedule({ workspaceMode: ui.WorkspaceMode.NEW_WORKTREE }));
    await f.settled(thread);
    rmSync(join(thread.cwd, "worker-started.txt"));
    await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    await f.sql(
      (sql) => sql`UPDATE threads SET archived_at = now() - interval '24 hours' WHERE id = ${thread.id}::uuid`,
    );
    await f.settings({ cleanupSettled: true, cleanupDeletedThreads: false });
    expect((await f.entry(thread.worktree!.id)).wouldRemove).toBe(true);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === thread.worktree!.id)?.removed).toBe(true);
    expect(
      await failure(
        schedule({
          workspaceId: qualifyId(f.workspace.id, "ab".repeat(32)),
          workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        }),
      ),
    ).toContain("That computer is no longer linked");
  });
});
