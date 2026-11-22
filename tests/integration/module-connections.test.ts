import { describe, expect, test } from "bun:test";
import { InteractionKind, Provider } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { GatewayStore } from "@canopy/gateway/store";
import { initializeModuleExecution } from "../../apps/gateway/src/store/module-transitions.ts";
import { moduleDisabledMessage } from "../../apps/gateway/src/store/module-access.ts";
import { botsSuite, lastInput, reply, tool } from "./support/bots.ts";
import { eventually, failure } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("owner module settings on the gateway", () => {
  const { suite, add, read, send, settled } = botsSuite();

  async function modules(...enabled: string[]) {
    const { user } = await suite.gw.api.getSettings({});
    await suite.gw.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
  }

  for (const enabled of ["bots", "threads"]) {
    test(`keeping only ${enabled} expires pending proposals and refuses the bot's earlier tool catalog`, async () => {
      const waiting = await add(`Waiting ${enabled}`, { approvalPolicy: "always" });
      const active = await add(`Active ${enabled}`, { approvalPolicy: "full_auto" });
      const announced = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const project = suite.projectId;
      suite.model = async (input) => {
        const last = input.messages.at(-1)!;

        if (last.role === "tool") return reply(last.text);

        if (lastInput(input) === "Catalog") return reply(input.tools.map((t) => t.name).join(","));

        if (input.configuration.name === waiting.configuration!.name)
          return tool("rename_project", { project_id: project, name: "Renamed by approval" });
        announced.resolve();
        await release.promise;

        return tool("archive_project", { project_id: project });
      };

      try {
        await send(waiting.id, "Rename");

        const pending = await eventually(
          () => read(waiting.id),
          (s) => s.approvals.some((a) => a.status === "pending"),
        );

        const id = pending.approvals[0]!.id;
        await send(active.id, "Archive");
        await announced.promise;
        await modules(enabled);
        release.resolve();
        expect(await failure(suite.gw.api.answerBotApproval({ approvalId: id, approve: true }))).toContain(
          enabled === "bots" ? "expired" : moduleDisabledMessage("bots"),
        );
        expect((await read(waiting.id)).approvals.find((a) => a.id === id)?.status).toBe("expired");
        const conversation = await settled(active.id);
        expect(conversation.working).toBe(false);
        expect((await suite.gw.api.getOverview({})).projects.find((p) => p.id === project)?.name).toBe("Bot project");

        if (enabled === "threads") {
          expect(conversation.messages.at(-1)?.text).toContain("Bots was turned off");

          const blocked = suite.gw.api.sendBotMessage({
            botId: active.id,
            text: "Catalog",
            clientRequestId: crypto.randomUUID(),
          });

          expect(await failure(blocked)).toContain(moduleDisabledMessage("bots"));
        } else {
          expect(conversation.messages.at(-1)?.text).toContain("Enable both Threads and Bots");
          await send(active.id, "Catalog");
          const names = (await settled(active.id)).messages.at(-1)!.text.split(",");
          expect(names).toContain("send_bot_message");
          expect(names).toContain("schedule_wakeup");

          for (const tool of [
            "list_threads",
            "get_thread",
            "start_thread",
            "answer_interaction",
            "archive_project",
            "create_schedule",
          ])
            expect(names).not.toContain(tool);
        }
      } finally {
        release.resolve();
        await modules("bots", "threads");
      }

      await send(active.id, "Catalog");
      expect((await settled(active.id)).messages.at(-1)!.text.split(",")).toContain("start_thread");
    }, 20_000);
  }

  test("startup stops work left by an older visibility-only preference exactly once", async () => {
    const waiting = await add("Before upgrade", { approvalPolicy: "always" });
    suite.model = async () => tool("rename_project", { project_id: suite.projectId, name: "Earlier request" });

    try {
      await send(waiting.id, "Propose a change");

      const pending = await eventually(
        () => read(waiting.id),
        (c) => c.approvals.some((a) => a.status === "pending"),
      );

      const approval = pending.approvals[0]!;
      const { runtime, userId } = suite.gw;
      await runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`UPDATE user_settings SET settings = (settings - 'suspendedModule') ||
          '{"modules":{"enabled":["threads"]}}'::jsonb WHERE user_id = ${userId}::uuid`,
        ),
      );
      await runtime.runPromise(initializeModuleExecution(userId));
      const stopped = await read(waiting.id);
      expect(stopped.approvals.find((a) => a.id === approval.id)?.status).toBe("expired");
      expect(stopped.messages.at(-1)?.text).toContain("Bots was turned off");
      const { version } = (await suite.gw.api.getSettings({})).user!;
      await runtime.runPromise(initializeModuleExecution(userId));
      expect((await suite.gw.api.getSettings({})).user!.version).toBe(version);
      expect((await read(waiting.id)).messages).toEqual(stopped.messages);
    } finally {
      await modules("threads", "bots");
    }
  }, 20_000);

  test("a disconnected bot manages private reminders without listing or cancelling thread schedules", async () => {
    const bot = await add("Reminders only", { approvalPolicy: "full_auto" });

    const thread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        providerProfileId: "native",
      })
    ).thread!;

    const schedule = (
      await suite.gw.api.createSchedule({
        threadId: thread.id,
        prompt: "Private thread schedule",
        when: { case: "cron", value: "0 9 * * *" },
      })
    ).schedule!;

    let action = "schedule_wakeup";
    let args: JsonObject = { prompt: "Bot reminder", run_at: new Date(Date.now() + 3600_000).toISOString() };
    suite.model = async (input) =>
      input.messages.at(-1)?.role === "tool" ? reply(input.messages.at(-1)!.text) : tool(action, args);

    try {
      await modules("bots");
      await send(bot.id, "Remember");
      const reminder = (await settled(bot.id)).reminders[0]!;
      action = "list_schedules";
      args = {};
      await send(bot.id, "List");
      const list = (await settled(bot.id)).messages.at(-1)!.text;
      expect(list).toContain(reminder.id);
      expect(list).not.toContain(schedule.id);

      action = "cancel_schedule";
      args = { schedule_id: schedule.id };
      await send(bot.id, "Cancel schedule");
      expect((await settled(bot.id)).messages.at(-1)?.text).toContain("error");
      expect((await suite.gw.api.listSchedules({ threadId: thread.id })).schedules[0]?.status).toBe("active");

      args = { schedule_id: reminder.id };
      await send(bot.id, "Cancel reminder");

      const pending = await eventually(
        () => read(bot.id),
        (s) => s.approvals.some((a) => a.status === "pending"),
      );

      await suite.gw.api.answerBotApproval({
        approvalId: pending.approvals.find((a) => a.status === "pending")!.id,
        approve: true,
      });
      expect((await settled(bot.id)).reminders).toHaveLength(0);
    } finally {
      await modules("threads", "bots");
    }
  }, 20_000);

  test("list_schedules pages across schedule and wakeup boundaries within the bot's scope", async () => {
    const bot = await add("Schedule pages", { approvalPolicy: "full_auto" });
    const other = await add("Unlisted wakeup", { approvalPolicy: "full_auto" });

    const { thread } = await suite.gw.api.createThread({
      projectId: suite.projectId,
      workspaceId: suite.workspaceId,
      provider: Provider.CODEX,
    });

    const { schedule } = await suite.gw.api.createSchedule({
      threadId: thread!.id,
      prompt: "Platform entry",
      when: { case: "cron", value: "0 9 * * *" },
    });

    const runAt = new Date(Date.now() + 3600_000).toISOString();
    let action = "schedule_wakeup";
    let args: JsonObject = { prompt: "Same run time", run_at: runAt };
    suite.model = async (input) => {
      const last = input.messages.at(-1);

      return last?.role === "tool" ? reply(last.text) : tool(action, args);
    };

    await send(other.id, "Remember");
    const hidden = (await settled(other.id)).reminders[0]!.id;
    await send(bot.id, "First reminder");
    await settled(bot.id);
    await send(bot.id, "Second reminder");
    const own = (await settled(bot.id)).reminders.map((row) => row.id).sort();

    const list = async (parameters: JsonObject) => {
      action = "list_schedules";
      args = parameters;
      await send(bot.id, "List schedules");

      return JSON.parse((await settled(bot.id)).messages.at(-1)!.text);
    };

    expect(own).toHaveLength(2);
    const filters = { thread_id: thread!.id };
    const legacy = await list(filters);
    expect(legacy).toEqual({
      schedules: [expect.objectContaining({ id: schedule!.id })],
      wakeups: own.map((id) => expect.objectContaining({ id })),
    });
    expect(JSON.stringify(legacy)).not.toContain(hidden);
    const first = await list({ ...filters, limit: 2 });
    expect(first).toEqual({ schedules: legacy.schedules, wakeups: [legacy.wakeups[0]], page: { next_offset: 2 } });
    expect(await list({ ...filters, limit: 2, offset: first.page.next_offset })).toEqual({
      schedules: [],
      wakeups: [legacy.wakeups[1]],
      page: { next_offset: null },
    });
    expect(await list({ ...filters, limit: 2, offset: 3 })).toEqual({
      schedules: [],
      wakeups: [],
      page: { next_offset: null },
    });

    try {
      await modules("bots");
      expect(await list({ limit: 1 })).toEqual({
        schedules: [],
        wakeups: [legacy.wakeups[0]],
        page: { next_offset: 1 },
      });
      expect(await list({ limit: 1, offset: 1 })).toEqual({
        schedules: [],
        wakeups: [legacy.wakeups[1]],
        page: { next_offset: null },
      });
    } finally {
      await modules("threads", "bots");
    }
  }, 20_000);

  test("disconnecting an existing delegation removes its live approval and stops the completion report", async () => {
    const owner = await add("Delegator", { approvalPolicy: "full_auto" });
    const worker = suite.gw.worker;
    worker.holdTurns = true;
    suite.model = async (input) =>
      input.messages.at(-1)?.role === "tool" || lastInput(input).startsWith("Thread ")
        ? reply("Received")
        : tool("start_thread", {
            project_id: suite.projectId,
            workspace_id: suite.workspaceId,
            title: "Held delegation",
            provider: "codex",
            provider_instance: "native",
            prompt: "Wait",
          });

    try {
      await send(owner.id, "Delegate");
      await settled(owner.id);
      const { threads } = await suite.gw.api.listThreads({ projectId: suite.projectId });
      const threadId = threads.find((t) => t.title === "Held delegation")!.id;
      const snapshot = () => suite.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId)));
      const thread = await eventually(snapshot, (s) => s.turns[0]?.status === "running");
      const turnId = thread.turns[0]!.id;
      const requestId = Bun.randomUUIDv7();
      worker.ask({
        threadId,
        turnId,
        requestId,
        kind: InteractionKind.PERMISSION,
        toolName: "shell",
        requestJson: "{}",
      });
      await eventually(
        () => read(owner.id),
        (s) => s.approvals.some((a) => a.requestId === requestId),
      );

      await modules("threads");
      expect((await read(owner.id)).approvals.some((a) => a.requestId === requestId)).toBe(false);
      expect((await suite.gw.api.listThreadApprovals({ threadId })).approvals).toEqual([]);
      expect(await failure(suite.gw.api.answerBotApproval({ approvalId: requestId, approve: true }))).toContain(
        moduleDisabledMessage("bots"),
      );
      await suite.gw.api.answerInteraction({ requestId, allow: true });

      const cross = await worker.callTool({
        threadId,
        turnId,
        tool: "send_message",
        args: { thread_id: owner.id, target_kind: "bot", prompt: "Running" },
      });

      expect(cross.isError).toBe(true);
      expect(cross.content).toContain("Enable both");
      worker.finish(threadId, turnId, "Private completion");
      await eventually(snapshot, (s) => s.turns[0]?.status === "completed");
      await modules("threads", "bots");
      await suite.current.bots.run((s) => s.deliver(suite.gw.userId));
      expect((await read(owner.id)).messages.some((m) => m.senderId === threadId)).toBe(false);
    } finally {
      worker.holdTurns = false;
      await modules("threads", "bots");
    }
  }, 20_000);
});
