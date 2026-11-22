import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually } from "./support/gateway.ts";
import { botsSuite, reply, tool, lastInput } from "./support/bots.ts";
import republishBotSteers from "../../packages/db/src/migrations/0200_bot_steer_senders.sql" with { type: "text" };

const caughtUpBotSteer = (state: ui.ThreadSnapshot, text: string, update: ui.ThreadUpdate) =>
  update.change.case === "batch" &&
  update.change.value.caughtUp &&
  state.steers.some((steer) => steer.text === text && steer.status === "delivered");

describe.skipIf(!dockerAvailable)("gateway bots: remote MCP capabilities and worker threads", () => {
  const { suite, add, read, settled, send, restart } = botsSuite();

  test("mobile sequence reads keep bot steers visible live and repair sender attribution on resume", async () => {
    const { api, worker, runtime } = suite.gw;
    const projectId = (await api.createProject({ name: "Mobile steer history" })).project!.id;

    const workspaceId = (
      await api.createWorkspace({ projectId, workerId: suite.gw.workerId, rootPath: "/repo/mobile-steers" })
    ).workspace!.id;

    worker.holdTurns = true;

    const thread = (
      await api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        providerProfileId: "bots-test",
      })
    ).thread!;

    const turn = (await api.sendMessage({ threadId: thread.id, text: "Keep working while the bot sends an update" }))
      .turn!;

    await eventually(
      () => api.getThread({ threadId: thread.id }),
      (result) => result.thread?.status === "running",
    );

    const bot = await add("Service Desk");
    const report = "Received the thread result";
    const text = "The customer confirmed they use Canopy Desktop.";
    suite.model = async (input) => {
      if (lastInput(input).startsWith("Thread ")) return reply(report);

      return input.messages.at(-1)?.role === "tool"
        ? reply("Update sent")
        : tool("send_message", { thread_id: thread.id, text, delivery: "steer" });
    };

    const abort = new AbortController();
    const request = { threadId: thread.id, sequence: true, pageSize: 24 };
    const options = { signal: abort.signal, timeoutMs: 12_000 };
    const stream = api.watchThread(request, options)[Symbol.asyncIterator]();
    let state: ui.ThreadSnapshot | undefined;

    try {
      const initial = await stream.next();

      if (initial.done) throw new Error("Mobile watch ended before the initial window");
      state = applyThreadUpdate(undefined, initial.value);
      await send(bot.id, "Forward the update");
      await settled(bot.id);

      for (;;) {
        const next = await stream.next();

        if (next.done) throw new Error("Mobile watch ended before the steer arrived");
        state = applyThreadUpdate(state, next.value);

        if (caughtUpBotSteer(state, text, next.value)) break;
      }
    } finally {
      abort.abort();
      await stream.return?.();
      worker.holdTurns = false;
      worker.finish(thread.id, turn.id, "Finished");
      await eventually(
        () => api.getThread({ threadId: thread.id }),
        (result) => result.thread?.status === "idle",
      );
    }

    const steer = state.steers.find((entry) => entry.text === text)!;

    expect(steer.sender?.botId).toBe(bot.id);
    expect(
      state.items.some(({ item }) => item?.content.case === "userMessage" && item.content.value.clientId === steer.id),
    ).toBe(true);

    // An older app already acknowledged this checkpoint with the delivered item and no sender.
    steer.sender = undefined;
    await runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe(republishBotSteers)));

    const resume = new AbortController();

    try {
      for await (const update of api.watchThread(
        { ...request, syncCursor: state.syncCursor },
        { signal: resume.signal, timeoutMs: 8_000 },
      )) {
        expect(update.change.case).not.toBe("snapshot");
        state = applyThreadUpdate(state, update);

        if (caughtUpBotSteer(state, text, update) && state.steers.some((entry) => entry.sender?.botId === bot.id))
          break;
      }
    } finally {
      resume.abort();
    }

    expect(state.steers.find((entry) => entry.id === steer.id)?.sender?.title).toBe("Service Desk");
    expect(
      state.items.filter(
        ({ item }) => item?.content.case === "userMessage" && item.content.value.clientId === steer.id,
      ),
    ).toHaveLength(1);

    const finished = await eventually(
      () => read(bot.id),
      (result) => !result.working && result.messages.some((message) => message.text === report),
    );

    expect(finished.messages.some((message) => message.text === report)).toBe(true);
  }, 20_000);

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

    const startCard = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: startCard.approvals.find((a) => a.status === "pending")!.id,
        approve: true,
      }),
    );
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

    const startCard = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: startCard.approvals.find((a) => a.status === "pending")!.id,
        approve: true,
      }),
    );

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

      const startCard = await eventually(
        () => read(bot.id),
        (s) => s.approvals.some((a) => a.status === "pending"),
      );

      await suite.current.bots.answer(
        create(bots.AnswerBotApprovalRequestSchema, {
          approvalId: startCard.approvals.find((a) => a.status === "pending")!.id,
          approve: true,
        }),
      );

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
      const text = `steer ${mode}`;

      suite.model = async (i) => {
        if (lastInput(i).startsWith("Thread ")) {
          expect(lastInput(i)).toContain(mode === "not_running" ? "Echo: steer not_running" : "Finished accept");

          return reply(`Result ${mode}`);
        }

        return i.messages.at(-1)?.role === "tool"
          ? reply("Message sent")
          : tool("send_message", { thread_id: thread.id, text, delivery: "steer" });
      };

      const updates: ui.Steer[] = [];

      const stopObserving = suite.current.hub.observeThread(thread.id, ({ change }) => {
        if (change.case === "steer" && change.value.text === text) updates.push(change.value);
      });

      try {
        await send(bot.id, "steer it");
        await settled(bot.id);
      } finally {
        stopObserving();
      }

      expect(updates[0]).toMatchObject({ status: "pending", sender: { botId: bot.id } });

      const status = mode === "accept" ? "delivered" : "queued";

      const snapshot = await eventually(
        () => suite.current.linkedAgents.snapshot(thread.id),
        (s) => s.steers.some((steer) => steer.text === text && steer.status === status),
      );

      const steer = snapshot.steers.find((entry) => entry.text === text && entry.status === status)!;

      expect(steer.sender).toMatchObject({
        botId: bot.id,
        title: bot.configuration!.name,
        botShape: bot.configuration!.shape,
        botColor: bot.configuration!.color,
      });

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
