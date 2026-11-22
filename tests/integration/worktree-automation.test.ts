import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { CommandSchema, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { AgentBusStore, GatewayStore } from "@canopy/gateway/store";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { eventually, failure } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";
import type { JsonObject } from "@canopy/domain";
import { qualifyId } from "@canopy/domain/computers";
import {
  WORKTREE_CHECKOUT_DEADLINE,
  WORKTREE_PREPARATION_TIMEOUT_MS,
  WORKTREE_QUERY_TIMEOUT_MS,
} from "@canopy/domain/worktree-timing";
import type { ModelReply } from "../../apps/gateway/src/bots/types.ts";

describe.skipIf(!dockerAvailable)("automation worktrees over gRPC", () => {
  const dir = tempDir("canopy-worktree-automation-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  const botRequests = new Map<string, JsonObject>();
  beforeAll(async () => {
    f = await worktreeFixture(dir, {
      capabilities: [WORKTREE_CHECKOUT_DEADLINE],
      botModel: async ({ turn, messages }): Promise<ModelReply> => {
        // A delegated thread can queue its own bot turn while the next request is pending.
        const args = turn && botRequests.get(turn.client_request_id);

        return args && messages.at(-1)?.role !== "tool"
          ? { text: "", calls: [{ id: "start-thread", name: "start_thread", arguments: args }] }
          : { text: "Acknowledged", calls: [] };
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
    const timedCheckout = "Git timed out after 60.012 s while creating the worktree. The limit was 60 s.";
    const cleanupWarning = " Canopy could not finish cleanup. Check the worktree and branch before retrying.";
    const privateError = "fatal: cannot read /private/worker/repo during checkout";

    const failures = [
      ["timed-checkout", "GIT_TIMEOUT", timedCheckout, timedCheckout],
      ["timed-checkout-cleanup", "GIT_TIMEOUT", timedCheckout + cleanupWarning, timedCheckout + cleanupWarning],
      [
        "unsafe-timeout",
        "GIT_TIMEOUT",
        timedCheckout + "\n" + privateError,
        "Git timed out while creating the worktree.",
      ],
      ["untimed-checkout", "GIT_TIMEOUT", "Git exceeded its time limit.", "Git timed out while creating the worktree."],
      [
        "legacy-limit",
        "GIT_TIMEOUT",
        "git exceeded its time or output limit",
        "Git exceeded its time or output limit while creating the worktree.",
      ],
      ["output-limit", "GIT_OUTPUT_LIMIT", timedCheckout, "Git exceeded its output limit while creating the worktree."],
      ["busy", "GIT_BUSY", privateError, "Git is busy on the worker. Try creating the worktree again shortly."],
      [
        "unavailable",
        "GIT_UNAVAILABLE",
        privateError,
        "Git could not start on the worker. Check the Git installation.",
      ],
      [
        "checkout-failed",
        "WORKTREE_CHECKOUT_FAILED",
        privateError,
        "Git could not check out the worktree. Check the Git settings and filters.",
      ],
      [
        "creation-failed",
        "WORKTREE_FAILED",
        privateError + cleanupWarning,
        "Git could not create the worktree." + cleanupWarning,
      ],
      ["unknown-code", "constructor", privateError, "Could not create a worktree."],
    ] as const;

    const responses = new Map(failures.map(([ref, code, detail]) => [String(ref), { code, detail }]));

    const handle = f.host.handleCommand.bind(f.host);
    const attempts: string[] = [];

    const worker = spyOn(f.host, "handleCommand").mockImplementation(async (command) => {
      if (command.kind.case !== "createWorktree") return handle(command);
      const ref = command.kind.value.baseRef;
      const response = responses.get(ref);

      if (!response) return handle(command);
      attempts.push(ref);

      return {
        commandId: command.commandId,
        ok: false,
        errorCode: response.code,
        errorMessage: response.detail,
      };
    });

    try {
      for (const [ref, , , reason] of failures) {
        const args = { title: "Child", prompt: "Code task", workspace_mode: "new_worktree", base_ref: ref };
        const callId = Bun.randomUUIDv7();
        const result = await f.callTool(parent.id, args, callId);
        expect(result).toMatchObject({ isError: true, content: reason, resultJson: JSON.stringify({ error: reason }) });
        expect(await f.callTool(parent.id, args, callId)).toEqual(result);
      }

      expect(attempts).toEqual(failures.map(([ref]) => ref));
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

    const gateway = spyOn(link, "sendCommand").mockImplementation((kind, timeout, ...rest) => {
      if (kind.case !== "createWorktree") return send(kind, timeout, ...rest);
      expect(timeout).toBe(WORKTREE_QUERY_TIMEOUT_MS);
      const remaining = Number(kind.value.checkoutStartDeadlineMs) - Date.now();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(WORKTREE_PREPARATION_TIMEOUT_MS);

      return send(kind, 50, ...rest);
    });

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

  const fire = async (s: ui.Schedule, now = timestampDate(s.nextRunAt!)) => {
    await f.gw.core.scheduler.tick(now);
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

  test("a revoked lease leaves one reusable checkout when Threads resumes", async () => {
    const s = await schedule({ workspaceMode: ui.WorkspaceMode.NEW_WORKTREE });
    const now = timestampDate(s.nextRunAt!);
    const created = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handle = f.host.handleCommand.bind(f.host);
    const requests: string[] = [];

    const worker = spyOn(f.host, "handleCommand").mockImplementation(async (command) => {
      const result = await handle(command);

      if (command.kind.case === "createWorktree") {
        requests.push(command.commandId);
        created.resolve();
        await release.promise;
      }

      return result;
    });

    const toggle = async (enabled: string[]) => {
      const { user } = await f.gw.api.getSettings({});
      await f.gw.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
    };

    const before = git(f.repo, "worktree", "list", "--porcelain");
    const stale = f.gw.core.scheduler.tick(now);

    try {
      await created.promise;
      await toggle(["bots"]);
      await toggle(["threads", "bots"]);

      const [reclaimed] = await f.gw.runtime.runPromise(
        AgentBusStore.use((store) => store.claimDueSchedules("replacement", now, 180, 1)),
      );

      expect(reclaimed?.id).toBe(s.id);

      const firing = await f.gw.runtime.runPromise(
        AgentBusStore.use((store) =>
          store.fireSchedule({
            schedule: reclaimed!,
            run: true,
            input: { note: "", message: s.prompt },
            nextRunAt: undefined,
            eligibleWorkerIds: [f.workerId],
            now,
            prepareWorkspace: async () => {
              throw new Error("The original checkout is still being prepared.");
            },
          }),
        ),
      );

      expect(firing.threadId).toBe("");
      release.resolve();
      await stale;
      const held = (await f.gw.api.listSchedules({})).schedules.find((item) => item.id === s.id);
      expect(held?.runs).toBe(0);
      const thread = await fire(s, new Date(now.getTime() + 6_000));
      expect(thread.worktree?.path).toBe(thread.cwd);
      expect(requests).toHaveLength(1);
      const physical = git(f.repo, "worktree", "list", "--porcelain");
      expect(physical.split("worktree ").length - before.split("worktree ").length).toBe(1);
    } finally {
      release.resolve();
      worker.mockRestore();
      await stale;
      await toggle(["threads", "bots"]);
    }
  });

  test("reuses the worker's recorded checkout when its first result is lost", async () => {
    const s = await schedule({ workspaceMode: ui.WorkspaceMode.NEW_WORKTREE });
    const now = timestampDate(s.nextRunAt!);
    const handle = f.host.handleCommand.bind(f.host);
    const requests: string[] = [];

    const worker = spyOn(f.host, "handleCommand").mockImplementation(async (command) => {
      const result = await handle(command);

      if (command.kind.case === "createWorktree") {
        requests.push(command.commandId);

        if (requests.length === 1) return { commandId: command.commandId, ok: false, errorCode: "ACK_LOST" };
      }

      return result;
    });

    const before = git(f.repo, "worktree", "list", "--porcelain");

    try {
      await f.gw.core.scheduler.tick(now);
      await f.gw.core.scheduler.tick(new Date(now.getTime() + 6_000));
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);

      const current = (await f.gw.api.listSchedules({ includeFinished: true })).schedules.find(
        (row) => row.id === s.id,
      );

      expect(current?.runs).toBe(1);
      const physical = git(f.repo, "worktree", "list", "--porcelain");
      expect(physical.split("worktree ").length - before.split("worktree ").length).toBe(1);
    } finally {
      worker.mockRestore();
    }
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
      const clientRequestId = Bun.randomUUIDv7();
      botRequests.set(clientRequestId, {
        project_id: f.project.id,
        workspace_id: f.workspace.id,
        provider: "codex",
        provider_instance: "native",
        model: "gpt-6.1-sol",
        prompt: "Code task",
        ...extra,
      });

      try {
        const { turnId } = await f.gw.api.sendBotMessage({ botId: bot.id, text: "Run code", clientRequestId });

        const [result] = await eventually(
          () =>
            f.sql(
              (sql) => sql<{ status: string; finished: boolean; thread_id: string | null; error: string | null }>`
            SELECT t.status, t.finished_at IS NOT NULL AS finished,
                   c.result->>'thread_id' AS thread_id, c.result->>'error' AS error
            FROM bot_turns t LEFT JOIN bot_tool_calls c ON c.turn_id=t.id AND c.tool->>'name'='start_thread'
            WHERE t.id=${turnId}::uuid`,
            ),
          ([row]) => row?.finished === true,
        );

        if (!result?.finished || result.status !== "completed" || !result.thread_id)
          throw new Error(`Bot turn ${turnId} did not create a thread: ${JSON.stringify(result)}`);

        return (await f.gw.api.getThread({ threadId: result.thread_id })).thread!;
      } finally {
        botRequests.delete(clientRequestId);
      }
    };

    await f.settings({ defaultMode: ui.WorkspaceMode.NEW_WORKTREE });

    try {
      const isolated = await runBot({});
      await f.settled(isolated);

      const [start] = await f.sql(
        (sql) =>
          sql<{
            payload: Uint8Array;
          }>`SELECT payload FROM worker_commands WHERE thread_id=${isolated.id}::uuid AND kind='createThread'`,
      );

      const command = fromBinary(CommandSchema, start!.payload);
      expect(command.kind.case === "createThread" && command.kind.value.thread?.hasDelegatingBot).toBe(true);
      expect(readFileSync(join(isolated.cwd, "worker-started.txt"), "utf8")).toBe(isolated.cwd);
      const inherited = await runBot({ workspace_mode: "inherit_parent", parent_thread_id: isolated.id });
      expect([inherited.cwd, inherited.worktree?.id]).toEqual([isolated.cwd, isolated.worktree!.id]);
      const checkout = await runBot({ workspace_mode: "checkout" });
      expect([checkout.cwd, checkout.worktree]).toEqual([f.repo, undefined]);
    } finally {
      await f.settings({ defaultMode: ui.WorkspaceMode.CHECKOUT });
    }
  }, 30_000);

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
