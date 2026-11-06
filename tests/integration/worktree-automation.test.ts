import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
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

  const idle = (thread: ui.Thread) =>
    eventually(
      () => f.gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );

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
    await idle(isolated);
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
    await idle(child);
    rmSync(join(child.cwd, "worker-started.txt"));
    await f.gw.api.deleteThread({ threadId: child.id });
    await f.settings({ cleanupDeletedThreads: true });
    expect((await f.entry(child.worktree!.id)).wouldRemove).toBe(true);
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
    await idle(thread);
    rmSync(join(thread.cwd, "worker-started.txt"));
    await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
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
