import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually } from "./support/gateway.ts";
import { botsSuite, reply, tool, lastInput } from "./support/bots.ts";

describe.skipIf(!dockerAvailable)("gateway bots: remote MCP capabilities and worker threads", () => {
  const { suite, add, read, settled, send, restart } = botsSuite();

  test("remote MCP registry hides secrets, denies stdio, and requires approval for writes", async () => {
    expect((await suite.gw.api.testBotMcpServer({ serverId: suite.serverId })).tools[0]?.name).toBe(
      "send_external_message",
    );
    expect(JSON.stringify(await suite.gw.api.listBotMcpServers({}))).not.toContain("fixture-secret");
    expect((await suite.gw.api.listBotMcpServers({})).servers[0]?.headerNames).toEqual(["authorization"]);
    const bot = await add("Approval", { mcpServerIds: [suite.serverId] });
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply(i.messages.at(-1)!.text)
        : tool(i.tools.find((t) => t.source === "mcp")!.name, { text: "hello externally" });
    const before = suite.writes;
    await send(bot.id, "send");

    const waiting = await eventually(
      () => read(bot.id),
      (s) => s.statusLine === "Waiting for you",
    );

    expect(waiting.statusLine).toBe("Waiting for you");
    expect(suite.writes).toBe(before);
    const approval = waiting.approvals[0]!;
    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, { approvalId: approval.id, approve: true }),
    );
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("Sent once");
    expect(suite.writes).toBe(before + 1);
    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, { approvalId: approval.id, approve: true }),
    );
    expect(suite.writes).toBe(before + 1);
    await send(bot.id, "discard");

    const pending = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: pending.approvals.find((a) => a.status === "pending")!.id,
        approve: false,
      }),
    );
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("discarded");
    expect(suite.writes).toBe(before + 1);
  }, 20_000);

  test("MCP side effect in flight at restart is interrupted, never silently retried", async () => {
    const bot = await add("Remote restart", { mcpServerIds: [suite.serverId] });
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply(i.messages.at(-1)!.text)
        : tool(i.tools.find((t) => t.source === "mcp")!.name, { text: "only once" });
    suite.holdMcp = true;
    const before = suite.writes;
    await send(bot.id, "send once");

    const waiting = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, { approvalId: waiting.approvals[0]!.id, approve: true }),
    );
    await eventually(
      async () => suite.writes,
      (n) => n === before + 1,
    );
    expect(suite.writes).toBe(before + 1);
    await restart();
    suite.holdMcp = false;
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("interrupted");
    expect(suite.writes).toBe(before + 1);
  }, 20_000);

  test("worker thread creation and result notification survive restart without duplicate actions", async () => {
    const bot = await add("Worker bridge");
    const modelWaiting = Promise.withResolvers<void>();
    suite.model = async (i) => {
      if (lastInput(i).startsWith("Thread ")) return reply("Got the thread result");

      if (i.messages.at(-1)?.role === "tool") {
        modelWaiting.resolve();
        await new Promise<void>((resolve) => i.signal.addEventListener("abort", () => resolve(), { once: true }));
        i.signal.throwIfAborted();
      }

      return tool("start_thread", {
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        provider: "codex",
        provider_instance: "bots-test",
        model: "gpt-6.1-sol",
        prompt: "hello worker",
      });
    };

    await send(bot.id, "start worker");
    await modelWaiting.promise;
    await suite.current.bots.stop();
    // The worker finishes while bot execution is stopped. Its result must be in
    // PostgreSQL before dropping the fixture link (which has no replay journal).
    await eventually(
      async () =>
        suite.gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return yield* sql<{
              status: string;
            }>`SELECT t.status FROM turns t JOIN bot_thread_watches w ON w.target_turn_id = t.id WHERE w.bot_id = ${bot.id}::uuid`;
          }),
        ),
      (rows) => rows[0]?.status === "completed",
      10_000,
    );
    suite.model = async (i) => {
      if (!lastInput(i).startsWith("Thread ")) return reply("Started once");
      expect(lastInput(i)).toContain("Echo: hello worker");

      return reply("Got the thread result");
    };

    await restart();

    const final = await eventually(
      () => read(bot.id),
      (s) => s.messages.some((m) => m.text === "Got the thread result"),
      10_000,
    );

    expect(final.messages.filter((m) => m.kind === "event" && m.text.endsWith(" finished"))).toHaveLength(1);
    expect((await suite.gw.api.listThreads({ projectId: suite.projectId })).threads).toHaveLength(1);

    const counts = await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          n: string;
        }>`SELECT count(*)::text n FROM bot_thread_watches WHERE bot_id = ${bot.id}::uuid AND delivered`;
      }),
    );

    expect(counts[0]?.n).toBe("1");
  }, 20_000);

  test("a bot discovers No project and starts a worker thread in its dedicated scratch cwd", async () => {
    const scratch = (await suite.current.overview()).projects.find((p) => p.kind === "scratch")!;
    const placement = scratch.workspaces.find((w) => w.workerId === suite.gw.workerId)!;
    const bot = await add("Scratch bridge");
    suite.model = async (input) => {
      if (lastInput(input).startsWith("Thread ")) return reply("Scratch worker finished");
      const last = input.messages.at(-1);

      if (last?.role !== "tool") return tool("list_projects");
      const result = JSON.parse(last.text) as unknown;

      if (Array.isArray(result)) {
        expect(result).toContainEqual(expect.objectContaining({ id: scratch.id, name: "No project", kind: "scratch" }));

        return tool("start_thread", {
          project_id: scratch.id,
          workspace_id: placement.id,
          provider: "codex",
          provider_instance: "bots-test",
          model: "gpt-6.1-sol",
          prompt: "inspect scratch",
        });
      }

      return reply("Started scratch worker");
    };

    await send(bot.id, "start without a project");

    const snapshot = await eventually(
      () => read(bot.id),
      (s) => !s.working && s.messages.some((m) => m.text === "Scratch worker finished"),
      10_000,
    );

    expect(snapshot.messages.some((m) => m.text === "Started scratch worker")).toBe(true);
    const threads = await suite.current.listThreads(scratch.id);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread).toMatchObject({
      projectId: scratch.id,
      workspaceId: placement.id,
      workerId: suite.gw.workerId,
      cwd: `${placement.rootPath}/${thread.id}`,
    });

    const command = suite.currentWorker.commands.find(
      (c) => c.case === "createThread" && c.value.thread?.threadId === thread.id,
    );

    expect(command?.case === "createThread" && command.value.thread).toMatchObject({ scratch: true, cwd: thread.cwd });
  }, 20_000);

  test("a committed platform result wins over a failure in post-commit dispatch", async () => {
    const bot = await add("Committed action");
    const count = (await suite.current.listThreads(suite.projectId)).length;
    const start = suite.current.startBotThread.bind(suite.current);
    suite.current.startBotThread = async (...args) => {
      await start(...args);
      throw new Error("fixture: connection failed after committing the platform action");
    };

    suite.model = async (i) => {
      if (lastInput(i).startsWith("Thread ")) return reply("Worker finished");
      const last = i.messages.at(-1);

      if (last?.role === "tool")
        return reply(JSON.parse(last.text).thread_id ? "Committed once" : "Lost committed result");

      return tool("start_thread", {
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        provider: "codex",
        provider_instance: "bots-test",
        model: "gpt-6.1-sol",
        prompt: "committed worker",
      });
    };

    try {
      await send(bot.id, "start once");

      const snapshot = await eventually(
        () => read(bot.id),
        (s) => !s.working && s.messages.some((m) => m.text === "Worker finished"),
        10_000,
      );

      expect(snapshot.messages.some((m) => m.text === "Committed once")).toBe(true);
      expect((await suite.current.listThreads(suite.projectId)).length).toBe(count + 1);
    } finally {
      suite.current.startBotThread = start;
    }
  }, 15_000);

  test("bot messages steer a worker, or fall back to a queued bot turn with one completion notification", async () => {
    for (const mode of ["accept", "not_running"] as const) {
      suite.currentWorker.holdTurns = true;
      suite.currentWorker.steerMode = mode;

      const thread = await suite.current.createThread(
        create(ui.CreateThreadRequestSchema, {
          projectId: suite.projectId,
          workspaceId: suite.workspaceId,
          provider: Provider.CODEX,
          providerProfileId: "bots-test",
          model: "gpt-6.1-sol",
          initialMessage: `held ${mode}`,
        }),
      );

      await eventually(
        () => suite.current.getThread(thread.id),
        (t) => t.status === "running",
      );
      const bot = await add(`Steer ${mode}`);
      suite.model = async (i) => {
        if (lastInput(i).startsWith("Thread ")) {
          expect(lastInput(i)).toContain(mode === "not_running" ? "Echo: steer not_running" : "Finished accept");

          return reply(`Result ${mode}`);
        }

        return i.messages.at(-1)?.role === "tool"
          ? reply("Message sent")
          : tool("send_message", { thread_id: thread.id, text: `steer ${mode}`, delivery: "steer" });
      };

      await send(bot.id, "steer it");
      await settled(bot.id);
      await eventually(
        async () => suite.currentWorker.steered.size,
        (n) => n > 0,
      );
      const target = await suite.gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(thread.id)));
      expect(target).toBeDefined();
      suite.currentWorker.holdTurns = false;
      suite.currentWorker.finish(thread.id, target!.id, `Finished ${mode}`);

      const result = await eventually(
        () => read(bot.id),
        (s) => s.messages.some((m) => m.text === `Result ${mode}`),
        10_000,
      );

      expect(result.messages.filter((m) => m.kind === "event" && m.text.endsWith(" finished"))).toHaveLength(1);
    }

    suite.currentWorker.steerMode = "accept";
  }, 25_000);

  test("thread settings and archiving use approval cards and existing authorized store paths", async () => {
    const thread = (await suite.current.listThreads(suite.projectId))[0]!;
    const bot = await add("Settings");
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Renamed")
        : tool("rename_thread", { thread_id: thread.id, title: "Bot renamed" });
    await send(bot.id, "rename");
    await settled(bot.id);
    expect((await suite.current.getThread(thread.id)).title).toBe("Bot renamed");
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Model updated")
        : tool("set_thread_model", { thread_id: thread.id, model: "gpt-6.1-sol", effort: "high" });
    await send(bot.id, "set model");

    const approval = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: approval.approvals.find((a) => a.status === "pending")!.id,
        approve: true,
      }),
    );
    await settled(bot.id);
    expect((await suite.current.getThread(thread.id)).effort).toBe("high");
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" ? reply("Archived") : tool("archive_thread", { thread_id: thread.id });
    await send(bot.id, "archive");

    const archive = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    expect((await suite.current.getThread(thread.id)).archivedAt).toBeUndefined();
    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: archive.approvals.find((a) => a.status === "pending")!.id,
        approve: true,
      }),
    );
    await settled(bot.id);
    expect((await suite.current.getThread(thread.id)).archivedAt).toBeDefined();
  }, 20_000);
});
