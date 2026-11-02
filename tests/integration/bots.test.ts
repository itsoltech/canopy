import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { bots, Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayCore } from "@open-agents/gateway/core";
import { GatewayStore } from "@open-agents/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startGrpcServer } from "@open-agents/transport";
import { openGatewayLink } from "@open-agents/worker/gateway-link";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import type { BotModel, ModelInput, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, ScriptedWorker, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });
const tool = (name: string, args: Record<string, unknown> = {}): ModelReply => ({ text: "", calls: [{ id: "model-call", name, arguments: args }] });
const lastInput = (input: ModelInput) => input.messages.findLast((m) => m.role === "user")?.text ?? "";

describe.skipIf(!dockerAvailable)("gateway bots: durable conversations, approvals and remote capabilities", () => {
  let gw: TestGateway;
  let model: BotModel = async (i) => reply(`Reply: ${lastInput(i)}`);
  let current: GatewayCore;
  let currentWorker: ScriptedWorker;
  let fixture: ReturnType<typeof Bun.serve>;
  let writes = 0;
  let holdMcp = false;
  let serverId = "";
  let workspaceId = "";
  let projectId = "";
  let closeRestartedLink = async () => {};
  const configuration = (name: string, extra: MessageInitShape<typeof bots.BotConfigurationSchema> = {}) => create(bots.BotConfigurationSchema, {
    name, shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "bots-test", model: "gpt-6.1-sol", ...extra,
  });
  const add = async (name: string, extra: MessageInitShape<typeof bots.BotConfigurationSchema> = {}) => (await gw.api.createBot({ configuration: configuration(name, extra), clientRequestId: Bun.randomUUIDv7() })).bot!;
  const read = (id: string) => current.bots.run((s) => s.conversation(gw.userId, id));
  const settled = (id: string) => eventually(() => read(id), (s) => !s.working, 10_000);
  const send = (id: string, text: string) => current.bots.send(create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }));
  const restart = async () => {
    await current.bots.stop();
    await closeRestartedLink();
    gw.worker.link.close();
    current = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: Bun.randomUUIDv7(), botModel: (i) => model(i) });
    const core = current;
    const grpc = await startGrpcServer({ routes: (router) => core.link.routes(router) });
    const link = await openGatewayLink({ baseUrl: grpc.url, credential: gw.workerCredential, hello: { workerId: gw.workerId, journalId: "bots-restarted" } });
    currentWorker = new ScriptedWorker(link);
    closeRestartedLink = async () => { link.close(); await core.link.shutdown(); await grpc.close(); };
    current.bots.start();
  };
  beforeAll(async () => {
    gw = await startTestGateway({ botModel: (input) => model(input) });
    current = gw.core;
    currentWorker = gw.worker;
    current.bots.start();
    await gw.api.saveProviderInstance({ harness: Provider.CODEX, id: "bots-test", label: "Bots test", create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
    const project = (await gw.api.createProject({ name: "Bot project" })).project!;
    projectId = project.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json() as { id?: number; method: string };
      if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      let result: unknown = {};
      if (body.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
      if (body.method === "tools/list") result = { tools: [{ name: "send_external_message", description: "Send externally", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: false } }] };
      if (body.method === "tools/call") {
        writes++;
        if (holdMcp) await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        result = { content: [{ type: "text", text: "Sent once" }] };
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    } });
    serverId = (await gw.api.saveBotMcpServer({ name: "Notion", url: `${fixture.url}mcp`, transport: "http", enabled: true, headers: { authorization: "Bearer fixture-secret" } })).server!.id;
  }, 30_000);
  afterAll(async () => { await current?.bots.stop(); await closeRestartedLink(); await fixture?.stop(true); await gw?.close(); });

  test("create/list/update and one idempotent conversation stream, hidden from Threads", async () => {
    model = async (i) => reply(`Reply: ${lastInput(i)}`);
    const requestId = Bun.randomUUIDv7();
    const request = { configuration: configuration("First"), clientRequestId: requestId };
    const a = (await gw.api.createBot(request)).bot!;
    expect((await gw.api.createBot(request)).bot!.id).toBe(a.id);
    expect((await gw.api.listBots({})).bots.some((b) => b.id === a.id)).toBe(true);
    const updated = await gw.api.updateBot({ botId: a.id, configuration: configuration("Renamed") });
    expect(updated.bot?.configuration?.name).toBe("Renamed");
    const sendRequest = { botId: a.id, text: "hello", clientRequestId: Bun.randomUUIDv7() };
    const first = await gw.api.sendBotMessage(sendRequest);
    expect((await gw.api.sendBotMessage(sendRequest)).turnId).toBe(first.turnId);
    expect((await settled(a.id)).messages.map((m) => m.text)).toEqual(["hello", "Reply: hello"]);
    await send(a.id, "second");
    expect((await settled(a.id)).messages.at(-1)?.text).toBe("Reply: second");
    expect((await gw.api.listBots({})).bots.find((b) => b.id === a.id)?.lastMessage?.text).toBe("Reply: second");
    const abort = new AbortController();
    for await (const snapshot of gw.api.watchBotConversation({ botId: a.id }, { signal: abort.signal })) {
      expect(snapshot.messages).toHaveLength(4); break;
    }
    abort.abort();
    expect((await gw.api.listThreads({})).threads).toHaveLength(0);
    const otherUser = Bun.randomUUIDv7();
    await expect(gw.runtime.runPromise(BotStore.use((s) => s.owned(otherUser, a.id)))).rejects.toThrow();
  });

  test("queued messages retain the preceding reply even when their input was saved earlier", async () => {
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const seen: string[][] = [];
    model = async (i) => {
      seen.push(i.messages.map((m) => m.text));
      if (lastInput(i) === "first queued") { started.resolve(); await proceed.promise; }
      return reply(`Answer: ${lastInput(i)}`);
    };
    const bot = await add("Queue history");
    await send(bot.id, "first queued");
    await started.promise;
    await send(bot.id, "second queued");
    proceed.resolve();
    await settled(bot.id);
    expect(seen).toEqual([["first queued"], ["first queued", "Answer: first queued", "second queued"]]);
  });

  test("gateway restart mid-inference resumes its durable input without duplicate messages", async () => {
    const started = Promise.withResolvers<void>();
    model = async (input) => { started.resolve(); await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true })); input.signal.throwIfAborted(); return reply("unreachable"); };
    const bot = await add("Restart");
    await send(bot.id, "survive restart");
    await started.promise;
    expect((await read(bot.id)).statusLine).toBe("Typing…");
    await current.bots.stop();
    model = async (i) => reply(`Recovered: ${lastInput(i)}`);
    await restart();
    expect((await settled(bot.id)).messages.map((m) => m.text)).toEqual(["survive restart", "Recovered: survive restart"]);
  });

  test("remote MCP registry hides secrets, denies stdio, and requires approval for writes", async () => {
    expect((await gw.api.testBotMcpServer({ serverId })).tools[0]?.name).toBe("send_external_message");
    expect(JSON.stringify(await gw.api.listBotMcpServers({}))).not.toContain("fixture-secret");
    expect((await gw.api.listBotMcpServers({})).servers[0]?.headerNames).toEqual(["authorization"]);
    const bot = await add("Approval", { mcpServerIds: [serverId] });
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply(i.messages.at(-1)!.text) : tool(i.tools.find((t) => t.source === "mcp")!.name, { text: "hello externally" });
    const before = writes;
    await send(bot.id, "send");
    const waiting = await eventually(() => read(bot.id), (s) => s.statusLine === "Waiting for you");
    expect(waiting.statusLine).toBe("Waiting for you");
    expect(writes).toBe(before);
    const approval = waiting.approvals[0]!;
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: approval.id, approve: true }));
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("Sent once");
    expect(writes).toBe(before + 1);
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: approval.id, approve: true }));
    expect(writes).toBe(before + 1);
    await send(bot.id, "discard");
    const pending = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: pending.approvals.find((a) => a.status === "pending")!.id, approve: false }));
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("discarded");
    expect(writes).toBe(before + 1);
  }, 20_000);

  test("MCP side effect in flight at restart is interrupted, never silently retried", async () => {
    const bot = await add("Remote restart", { mcpServerIds: [serverId] });
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply(i.messages.at(-1)!.text) : tool(i.tools.find((t) => t.source === "mcp")!.name, { text: "only once" });
    holdMcp = true;
    const before = writes;
    await send(bot.id, "send once");
    const waiting = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: waiting.approvals[0]!.id, approve: true }));
    await eventually(async () => writes, (n) => n === before + 1);
    expect(writes).toBe(before + 1);
    await restart();
    holdMcp = false;
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("interrupted");
    expect(writes).toBe(before + 1);
  }, 20_000);

  test("bot exchanges enqueue a target reply and a follow-up, preserving the hop limit", async () => {
    const a = await add("A");
    const b = await add("B");
    model = async (i) => i.configuration.name === "B" ? reply("B says hello") : lastInput(i).startsWith("Message from") ? reply("Received B's reply") : i.messages.at(-1)?.role === "tool" ? reply("Sent") : tool("send_bot_message", { bot_id: b.id, text: "hello B" });
    await send(a.id, "ask B");
    const result = await eventually(() => read(a.id), (s) => s.messages.some((m) => m.text === "Received B's reply"), 10_000);
    expect(result.messages.some((m) => m.text.includes("Message from B"))).toBe(true);
    const exchangeId = result.messages.find((m) => m.exchangeId)?.exchangeId!;
    expect((await current.bots.exchange(exchangeId)).some((m) => m.text === "B says hello")).toBe(true);
    await current.bots.run((s) => s.enqueue(gw.userId, a.id, "automated", Bun.randomUUIDv7(), { hops: 7 }));
    expect((await settled(a.id)).working).toBe(false);
    expect((await read(b.id)).messages.filter((m) => m.text.includes("hello B"))).toHaveLength(1);
  }, 20_000);

  test("worker thread creation and result notification survive restart without duplicate actions", async () => {
    const bot = await add("Worker bridge");
    const modelWaiting = Promise.withResolvers<void>();
    model = async (i) => {
      if (lastInput(i).startsWith("Thread ")) return reply("Got the thread result");
      if (i.messages.at(-1)?.role === "tool") {
        modelWaiting.resolve();
        await new Promise<void>((resolve) => i.signal.addEventListener("abort", () => resolve(), { once: true }));
        i.signal.throwIfAborted();
      }
      return tool("start_thread", { project_id: projectId, workspace_id: workspaceId, provider: "codex", provider_instance: "bots-test", model: "gpt-6.1-sol", prompt: "hello worker" });
    };
    await send(bot.id, "start worker");
    await modelWaiting.promise;
    await current.bots.stop();
    // The worker finishes while bot execution is stopped. Its result must be in
    // PostgreSQL before dropping the fixture link (which has no replay journal).
    await eventually(async () => gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ status: string }>`SELECT t.status FROM turns t JOIN bot_thread_watches w ON w.target_turn_id = t.id WHERE w.bot_id = ${bot.id}::uuid`;
    })), (rows) => rows[0]?.status === "completed", 10_000);
    model = async (i) => reply(lastInput(i).startsWith("Thread ") ? "Got the thread result" : "Started once");
    await restart();
    const final = await eventually(() => read(bot.id), (s) => s.messages.some((m) => m.text === "Got the thread result"), 10_000);
    expect(final.messages.some((m) => m.text.includes("Echo: hello worker"))).toBe(true);
    expect((await gw.api.listThreads({ projectId })).threads).toHaveLength(1);
    const counts = await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ n: string }>`SELECT count(*)::text n FROM bot_thread_watches WHERE bot_id = ${bot.id}::uuid AND delivered`;
    }));
    expect(counts[0]?.n).toBe("1");
  }, 20_000);

  test("a bot discovers No project and starts a worker thread in its dedicated scratch cwd", async () => {
    const scratch = (await current.overview()).projects.find((p) => p.kind === "scratch")!;
    const placement = scratch.workspaces.find((w) => w.workerId === gw.workerId)!;
    const bot = await add("Scratch bridge");
    model = async (input) => {
      if (lastInput(input).startsWith("Thread ")) return reply("Scratch worker finished");
      const last = input.messages.at(-1);
      if (last?.role !== "tool") return tool("list_projects");
      const result = JSON.parse(last.text) as unknown;
      if (Array.isArray(result)) {
        expect(result).toContainEqual(expect.objectContaining({ id: scratch.id, name: "No project", kind: "scratch" }));
        return tool("start_thread", { project_id: scratch.id, workspace_id: placement.id, provider: "codex", provider_instance: "bots-test", model: "gpt-6.1-sol", prompt: "inspect scratch" });
      }
      return reply("Started scratch worker");
    };
    await send(bot.id, "start without a project");
    const snapshot = await eventually(() => read(bot.id), (s) => !s.working && s.messages.some((m) => m.text === "Scratch worker finished"), 10_000);
    expect(snapshot.messages.some((m) => m.text === "Started scratch worker")).toBe(true);
    const threads = (await current.listThreads(scratch.id));
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread).toMatchObject({ projectId: scratch.id, workspaceId: placement.id, workerId: gw.workerId, cwd: `${placement.rootPath}/${thread.id}` });
    const command = currentWorker.commands.find((c) => c.case === "createThread" && c.value.thread?.threadId === thread.id);
    expect(command?.case === "createThread" && command.value.thread).toMatchObject({ scratch: true, cwd: thread.cwd });
  }, 20_000);

  test("a committed platform result wins over a failure in post-commit dispatch", async () => {
    const bot = await add("Committed action");
    const count = (await current.listThreads(projectId)).length;
    const start = current.startBotThread.bind(current);
    current.startBotThread = async (...args) => {
      await start(...args);
      throw new Error("fixture: connection failed after committing the platform action");
    };
    model = async (i) => {
      if (lastInput(i).startsWith("Thread ")) return reply("Worker finished");
      const last = i.messages.at(-1);
      if (last?.role === "tool") return reply(JSON.parse(last.text).thread_id ? "Committed once" : "Lost committed result");
      return tool("start_thread", { project_id: projectId, workspace_id: workspaceId, provider: "codex", provider_instance: "bots-test", model: "gpt-6.1-sol", prompt: "committed worker" });
    };
    try {
      await send(bot.id, "start once");
      const snapshot = await eventually(() => read(bot.id), (s) => !s.working && s.messages.some((m) => m.text === "Worker finished"), 10_000);
      expect(snapshot.messages.some((m) => m.text === "Committed once")).toBe(true);
      expect((await current.listThreads(projectId)).length).toBe(count + 1);
    } finally { current.startBotThread = start; }
  }, 15_000);

  test("bot messages steer a worker, or fall back to a queued bot turn with one completion notification", async () => {
    for (const mode of ["accept", "not_running"] as const) {
      currentWorker.holdTurns = true;
      currentWorker.steerMode = mode;
      const thread = await current.createThread(create(ui.CreateThreadRequestSchema, {
        projectId, workspaceId, provider: Provider.CODEX, providerProfileId: "bots-test", model: "gpt-6.1-sol", initialMessage: `held ${mode}`,
      }));
      await eventually(() => current.getThread(thread.id), (t) => t.status === "running");
      const bot = await add(`Steer ${mode}`);
      model = async (i) => lastInput(i).startsWith("Thread ") ? reply(`Result ${mode}`) : i.messages.at(-1)?.role === "tool" ? reply("Message sent") : tool("send_message", { thread_id: thread.id, text: `steer ${mode}`, delivery: "steer" });
      await send(bot.id, "steer it");
      await settled(bot.id);
      await eventually(async () => currentWorker.steered.size, (n) => n > 0);
      const target = await gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(thread.id)));
      expect(target).toBeDefined();
      currentWorker.holdTurns = false;
      currentWorker.finish(thread.id, target!.id, `Finished ${mode}`);
      const result = await eventually(() => read(bot.id), (s) => s.messages.some((m) => m.text === `Result ${mode}`), 10_000);
      expect(result.messages.filter((m) => m.kind === "event" && m.text.startsWith("Thread "))).toHaveLength(1);
      if (mode === "not_running") expect(result.messages.some((m) => m.text.includes("Echo: steer not_running"))).toBe(true);
    }
    currentWorker.steerMode = "accept";
  }, 25_000);

  test("thread settings and archiving use approval cards and existing authorized store paths", async () => {
    const thread = (await current.listThreads(projectId))[0]!;
    const bot = await add("Settings");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Renamed") : tool("rename_thread", { thread_id: thread.id, title: "Bot renamed" });
    await send(bot.id, "rename");
    await settled(bot.id);
    expect((await current.getThread(thread.id)).title).toBe("Bot renamed");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Model updated") : tool("set_thread_model", { thread_id: thread.id, model: "gpt-6.1-sol", effort: "high" });
    await send(bot.id, "set model");
    const approval = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: approval.approvals.find((a) => a.status === "pending")!.id, approve: true }));
    await settled(bot.id);
    expect((await current.getThread(thread.id)).effort).toBe("high");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Archived") : tool("archive_thread", { thread_id: thread.id });
    await send(bot.id, "archive");
    const archive = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    expect((await current.getThread(thread.id)).archivedAt).toBeUndefined();
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: archive.approvals.find((a) => a.status === "pending")!.id, approve: true }));
    await settled(bot.id);
    expect((await current.getThread(thread.id)).archivedAt).toBeDefined();
  }, 20_000);

  test("durable one-shot wakeups deliver once and cancellation prevents a turn", async () => {
    const bot = await add("Reminders");
    model = async (i) => lastInput(i) === "Reminder prompt" ? reply("Reminder received") : i.messages.at(-1)?.role === "tool" ? reply("Scheduled") : tool("schedule_wakeup", { run_at: new Date(Date.now() + 1500).toISOString(), prompt: "Reminder prompt" });
    await send(bot.id, "remind me");
    const received = await eventually(() => read(bot.id), (s) => s.messages.some((m) => m.text === "Reminder received"), 10_000);
    expect(received.messages.filter((m) => m.text === "Reminder prompt")).toHaveLength(1);
    model = async (i) => {
      const last = i.messages.at(-1);
      if (last?.role === "tool") {
        const result = JSON.parse(last.text) as { schedule_id?: string };
        return result.schedule_id ? tool("cancel_schedule", { schedule_id: result.schedule_id }) : reply("Cancelled");
      }
      return tool("schedule_wakeup", { run_at: new Date(Date.now() + 60_000).toISOString(), prompt: "Must not run" });
    };
    await send(bot.id, "cancel reminder");
    const pending = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: pending.approvals.find((a) => a.status === "pending")!.id, approve: true }));
    await settled(bot.id);
    const schedules = await current.bots.run((s) => s.wakeups(bot.id));
    expect(schedules.some((s) => s["cancelled"] === true)).toBe(true);
  }, 15_000);

  test("an expired lease cannot commit an old model answer after another gateway takes over", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    model = async () => { entered.resolve(); await release.promise; return reply("Stale answer"); };
    const bot = await add("Fenced");
    await send(bot.id, "take over");
    await entered.promise;
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE bot_turns SET lease_until = now() - interval '1 second' WHERE bot_id = ${bot.id}::uuid AND status = 'running'`;
    }));
    const competitor = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "competitor", botModel: async () => reply("New owner answer") });
    try {
      await competitor.bots.tick();
      expect((await settled(bot.id)).messages.at(-1)?.text).toBe("New owner answer");
      release.resolve();
      await current.bots.stop();
      expect((await read(bot.id)).messages.filter((m) => m.senderId === bot.id).map((m) => m.text)).toEqual(["New owner answer"]);
    } finally { release.resolve(); await competitor.bots.stop(); current.bots.start(); }
  }, 15_000);

  test("questions persist and approvals resume after a gateway restart; interrupt and delete work", async () => {
    const bot = await add("Questions");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply(i.messages.at(-1)!.text) : tool("ask_user", { question: "Which project?" });
    await send(bot.id, "question");
    const pending = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    await restart();
    await current.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: pending.approvals[0]!.id, approve: true, answer: "CRM" }));
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("CRM");
    await send(bot.id, "another question");
    await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === "pending"));
    await current.bots.interrupt(bot.id);
    expect((await read(bot.id)).working).toBe(false);
    await current.bots.remove(bot.id);
    expect((await current.bots.list()).some((b) => b.id === bot.id)).toBe(false);
  }, 20_000);
});
