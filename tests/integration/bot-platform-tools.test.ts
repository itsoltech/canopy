import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, InteractionKind, ItemStatus, PermissionMode, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { botPlatform } from "../../apps/gateway/src/bots/platform.ts";
import { PLATFORM_TOOLS } from "../../apps/gateway/src/bots/policy.ts";
import type { BotModel } from "../../apps/gateway/src/bots/types.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot platform tools through the UI core", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  let threadId = "";
  const requested = new Map<string, { name: string; args: Record<string, unknown> }>();
  const model: BotModel = async (input) => {
    const last = input.messages.at(-1)!;
    if (last.role === "tool") return { text: last.text, calls: [] };
    const prompt = input.messages.findLast((m) => m.role === "user")?.text ?? "";
    const task = requested.get(prompt);
    return task ? { text: "", calls: [{ id: "scripted-call", name: task.name, arguments: task.args }] } : { text: "Completion received", calls: [] };
  };
  // Bot names are unique per owner: every scripted bot gets its own.
  const config = () => create(bots.BotConfigurationSchema, { name: `Platform test ${Bun.randomUUIDv7().slice(-8)}`, shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "platform-test", model: "gpt-6.1-sol", approvalPolicy: "safe" });
  const read = (id: string) => gw.core.bots.run((s) => s.conversation(gw.userId, id));
  async function invoke<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, approval = false, policy = "safe"): Promise<T> {
    const token = Bun.randomUUIDv7();
    requested.set(token, { name, args });
    const bot = await gw.core.bots.create(create(bots.CreateBotRequestSchema, { configuration: { ...config(), approvalPolicy: policy }, clientRequestId: token }));
    await gw.core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: bot.id, text: token, clientRequestId: token }));
    let conversation = await eventually(() => read(bot.id), (s) => !s.working || s.approvals.some((a) => a.status === "pending"), 10_000);
    const pending = conversation.approvals.find((a) => a.status === "pending");
    if (approval) {
      expect(pending).toBeDefined();
      expect(pending!.prompt).toStartWith("Needs approval");
      await gw.core.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: pending!.id, approve: true }));
      conversation = await eventually(() => read(bot.id), (s) => !s.working, 10_000);
    } else expect(pending).toBeUndefined();
    expect(conversation.working).toBe(false);
    const result = conversation.messages.find((m) => m.senderId === bot.id && m.kind === "message" && /^[\[{]/.test(m.text));
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!.text) as T;
    // Each invocation uses a disposable bot; keep this broad suite within the owner cap.
    await gw.core.bots.remove(bot.id);
    return parsed;
  }
  beforeAll(async () => {
    gw = await startTestGateway({ botModel: model });
    await gw.api.saveProviderInstance({ harness: Provider.CODEX, id: "platform-test", label: "Platform", create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-private-key", env: [{ name: "PUBLIC_VALUE", value: "also-hidden" }, { name: "PRIVATE_VALUE", value: "fixture-private-env", secret: true }], allWorkers: true });
    // This suite disables its only worker instance; keep the bot API model explicitly configured.
    await gw.api.setInstanceModels({ harness: Provider.CODEX, id: "platform-test", models: { custom: ["gpt-6.1-sol"] } });
    await eventually(() => gw.core.overview(), (o) => o.workers.some((w) => w.id === gw.workerId && w.providerInstances.some((i) => i.id === "platform-test" && i.available)));
    gw.core.bots.start();
  }, 30_000);
  afterAll(async () => { await gw?.close(); });

  test("discover a worker without roots, add any absolute workspace, validate paths, start a thread and search its title", async () => {
    expect(PLATFORM_TOOLS.length).toBeLessThanOrEqual(50);
    expect(new Set(PLATFORM_TOOLS.map((t) => t.name)).size).toBe(PLATFORM_TOOLS.length);
    const workers = await invoke<{ id: string; provider_instances: unknown[] }[]>("list_workers", {}, false, "always");
    expect(workers.find((w) => w.id === gw.workerId)).not.toHaveProperty("allowed_roots");
    expect(await invoke("list_directory", { worker_id: gw.workerId, path: "/repo" })).toMatchObject({ entries: [{ name: "repo-a", is_directory: true }] });
    projectId = (await invoke<{ id: string }>("create_project", { name: "Bot provisioned" })).id;
    expect(await invoke("add_workspace", { project_id: projectId, worker_id: gw.workerId, root_path: "/missing-workspace" })).toMatchObject({ error: expect.stringContaining("does not exist") });
    expect(await invoke("add_workspace", { project_id: projectId, worker_id: gw.workerId, root_path: "relative" })).toMatchObject({ error: expect.stringContaining("absolute") });
    expect(await invoke("add_workspace", { project_id: projectId, worker_id: gw.workerId, root_path: "/elsewhere" })).toHaveProperty("id");
    workspaceId = (await invoke<{ id: string }>("add_workspace", { project_id: projectId, worker_id: gw.workerId, root_path: "/repo", label: "Primary" })).id;
    await invoke("rename_project", { project_id: projectId, name: "Provisioned renamed" });
    await invoke("update_workspace", { workspace_id: workspaceId, label: "Renamed workspace" });
    const started = await invoke<{ thread_id: string }>("start_thread", { project_id: projectId, workspace_id: workspaceId, provider: "codex", provider_instance: "platform-test", prompt: "pwd", title: "Find Me Across Projects", permission: "read_only" });
    threadId = started.thread_id;
    await eventually(() => gw.api.getThread({ threadId }), (s) => s.thread?.status === "idle");
    expect((await gw.api.getThread({ threadId })).thread).toMatchObject({ projectId, workspaceId, workerId: gw.workerId, cwd: "/repo" });
    expect(gw.worker.created.some((t) => t.threadId === threadId && t.cwd === "/repo")).toBe(true);
    expect(await invoke<unknown[]>("list_threads", { query: "find me", statuses: ["idle"] })).toEqual([expect.objectContaining({ id: threadId })]);
    expect(await invoke<unknown[]>("list_threads", { query: "find me", statuses: ["running"] })).toEqual([]);
    expect(await invoke("read_thread", { thread_id: threadId })).toMatchObject({ turns: [expect.objectContaining({ status: "completed" })], messages: [expect.objectContaining({ text: "Echo: pwd" })] });
  }, 30_000);

  test("user schedules support thread/new_thread, edits, optimistic conflicts, pause/resume and cancellation", async () => {
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await invoke<{ id: string; version: number }>("create_schedule", { thread_id: threadId, prompt: "later", run_at: runAt });
    const edited = await invoke<{ version: number }>("update_schedule", { schedule_id: scheduled.id, expected_version: scheduled.version, thread_id: threadId, prompt: "edited", run_at: runAt });
    expect(edited.version).toBe(scheduled.version + 1);
    expect(await invoke("update_schedule", { schedule_id: scheduled.id, expected_version: scheduled.version, thread_id: threadId, prompt: "stale", run_at: runAt })).toMatchObject({ error: expect.stringContaining("changed") });
    expect(await invoke("set_schedule_status", { schedule_id: scheduled.id, status: "paused" })).toMatchObject({ status: "paused" });
    expect(await invoke("set_schedule_status", { schedule_id: scheduled.id, status: "active" })).toMatchObject({ status: "active" });
    const pool = await invoke<{ id: string }>("create_schedule", { target: "new_thread", prompt: "periodic", cron: "0 * * * *", timezone: "Europe/Warsaw", new_thread: { project_id: projectId, placement: "round_robin", provider: "codex", provider_instance: "platform-test", permission: "read_only" } });
    expect((await gw.api.listSchedules({})).schedules.find((s) => s.id === pool.id)?.newThread?.placement).toBe("round_robin");
    expect(await invoke("cancel_schedule", { schedule_id: scheduled.id }, true)).toMatchObject({ status: "cancelled" });
    await invoke("cancel_schedule", { schedule_id: pool.id }, true);
    expect(await invoke("list_schedules", { include_finished: true })).toMatchObject({ schedules: expect.arrayContaining([expect.objectContaining({ id: scheduled.id, prompt: "edited", status: "cancelled" })]) });
  }, 30_000);

  test("thread forks inherit placement, goals use native commands and interruptions reach the worker", async () => {
    const turns = await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(threadId)));
    const fork = await invoke<{ thread_id: string }>("fork_thread", { thread_id: threadId, turn_id: turns[0]!.id, title: "Forked by bot" }, true);
    expect((await gw.api.getThread({ threadId: fork.thread_id })).thread).toMatchObject({ projectId, workspaceId, forkSourceThreadId: threadId, cwd: "/repo" });
    for (const action of ["set", "pause", "resume", "clear"]) {
      const result = await invoke("set_goal", { thread_id: fork.thread_id, action, ...(action === "set" && { objective: "Keep going", token_budget: 10000 }) });
      expect(result["status"]).toBe(action === "pause" ? "paused" : action === "clear" ? "cancelled" : "active");
    }
    await eventually(async () => gw.worker.commands.filter((c) => c.case === "setGoal"), (c) => c.length === 4);
    expect(gw.worker.commands.filter((c) => c.case === "setGoal")).toHaveLength(4);
    gw.worker.holdTurns = true;
    await gw.api.sendMessage({ threadId: fork.thread_id, text: "hold", clientRequestId: Bun.randomUUIDv7() });
    await eventually(() => gw.api.getThread({ threadId: fork.thread_id }), (s) => s.thread?.status === "running");
    await invoke("interrupt_thread", { thread_id: fork.thread_id });
    await eventually(async () => gw.worker.commands.some((c) => c.case === "interruptTurn" && c.value.threadId === fork.thread_id), Boolean);
    expect(gw.worker.commands.some((c) => c.case === "interruptTurn" && c.value.threadId === fork.thread_id)).toBe(true);
    const running = await gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(fork.thread_id)));
    if (running) gw.worker.finish(fork.thread_id, running.id);
    gw.worker.holdTurns = false;
    await invoke("set_thread_permission", { thread_id: fork.thread_id, permission: "full_auto" }, true);
    expect((await gw.api.getThread({ threadId: fork.thread_id })).thread?.permissionMode).toBe(PermissionMode.FULL_AUTO);
  }, 30_000);

  test("provider changes and defaults require approval; secrets and appearance never enter results", async () => {
    const instances = await invoke<unknown[]>("list_provider_instances");
    const serialized = JSON.stringify(instances);
    for (const secret of ["fixture-private-key", "fixture-private-env", "also-hidden"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("PUBLIC_VALUE");
    expect(await invoke("set_instance_worker", { provider: "codex", provider_instance: "platform-test", worker_id: gw.workerId, enabled: true, overrides: { apiKey: "never-accepted" } }, true)).toMatchObject({ error: expect.stringContaining("unknown field overrides") });
    expect(await invoke("list_workers", { constructor: "unexpected" })).toMatchObject({ error: expect.stringContaining("unknown field constructor") });
    await invoke("set_instance_models", { provider: "codex", provider_instance: "platform-test", favorites: ["gpt-5.5"], hidden: ["gpt-6.1-sol"] }, true);
    expect((await gw.api.listProviderInstances({})).instances.find((i) => i.id === "platform-test")?.models).toMatchObject({ favorites: ["gpt-5.5"], hidden: ["gpt-6.1-sol"] });
    await invoke("set_instance_worker", { provider: "codex", provider_instance: "platform-test", worker_id: gw.workerId, enabled: false }, true);
    expect((await gw.api.listProviderInstances({})).instances.find((i) => i.id === "platform-test")?.workers.find((w) => w.workerId === gw.workerId)?.enabled).toBe(false);
    await invoke("set_instance_worker", { provider: "codex", provider_instance: "platform-test", worker_id: gw.workerId, enabled: true }, true);
    const settings = await invoke<{ user: { version: string } }>("get_settings");
    expect(JSON.stringify(settings)).not.toContain("appearance");
    const updated = await invoke<{ version: string }>("update_settings", { expected_version: settings.user.version, thread_defaults: { workspaceId, provider: "PROVIDER_CODEX", permissionMode: "PERMISSION_MODE_READ_ONLY", models: [{ provider: "PROVIDER_CODEX", model: "gpt-5.5" }] }, text_generation: { threadTitleInstructions: "Use Polish" } }, true);
    expect(BigInt(updated.version)).toBe(BigInt(settings.user.version) + 1n);
    expect((await gw.api.getSettings({})).user?.textGeneration?.threadTitleInstructions).toBe("Use Polish");
    await invoke("update_settings", { expected_version: updated.version, text_generation: { threadTitleInstructions: "Use short Polish titles" } });
    expect((await gw.api.getSettings({})).user?.textGeneration?.threadTitleInstructions).toBe("Use short Polish titles");
    await invoke("set_project_defaults", { project_id: projectId, expected_version: "0", thread_defaults: { workspaceId, provider: "PROVIDER_CODEX" } }, true);
    const bot = await invoke<{ id: string }>("create_bot", { name: "Created by another bot", provider: "codex", provider_instance: "platform-test", model: "gpt-6.1-sol" }, true);
    expect((await gw.api.getBot({ botId: bot.id })).bot?.configuration?.name).toBe("Created by another bot");
  }, 30_000);

  test("pending interactions and background tasks use UI validation, and destructive actions wait for approval", async () => {
    const requestId = Bun.randomUUIDv7();
    gw.worker.ask({ requestId, threadId, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: '{"command":"pwd"}' });
    await eventually(() => gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId))), (s) => s.interactions.some((i) => i.requestId === requestId));
    await invoke("answer_interaction", { thread_id: threadId, request_id: requestId, allow: true }, true);
    await eventually(async () => gw.worker.interactionAnswers.some((a) => a.requestId === requestId), Boolean);
    expect(gw.worker.interactionAnswers).toContainEqual({ requestId, allow: true });
    // A question: a malformed answer comes back to the bot as an error naming the expected shape, with no card for the user;
    // a valid one gets a readable card (the question and the chosen label) and reaches the worker.
    const questionId = Bun.randomUUIDv7();
    gw.worker.ask({ requestId: questionId, threadId, kind: InteractionKind.QUESTION, toolName: "ask_user",
      requestJson: JSON.stringify({ questions: [{ id: "topic", header: "Topic", question: "Which riddle?", kind: "single_choice", options: [{ label: "Consciousness" }, { label: "Time" }] }] }) });
    await eventually(() => gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId))), (s) => s.interactions.some((i) => i.requestId === questionId));
    const rejected = await invoke<{ error: string }>("answer_interaction", { thread_id: threadId, request_id: questionId, answers: [{ id: "topic", kind: "choice", labels: ["Space"] }] });
    expect(rejected.error).toContain('topic (single_choice: "Consciousness", "Time")');
    const reading = await invoke<{ interactions: { request_id?: string; requestId?: string; answer_with?: string; request?: unknown }[] }>("read_thread", { thread_id: threadId });
    expect(reading.interactions.find((i) => (i.requestId ?? i.request_id) === questionId)).toMatchObject({ answer_with: expect.stringContaining("labels"), request: { questions: [expect.objectContaining({ id: "topic" })] } });
    const answerToken = Bun.randomUUIDv7();
    requested.set(answerToken, { name: "answer_interaction", args: { thread_id: threadId, request_id: questionId, answers: [{ id: "topic", kind: "choice", labels: ["Time"] }] } });
    const answering = await gw.core.bots.create(create(bots.CreateBotRequestSchema, { configuration: config(), clientRequestId: answerToken }));
    await gw.core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: answering.id, text: answerToken, clientRequestId: answerToken }));
    const card = (await eventually(() => read(answering.id), (s) => s.approvals.some((a) => a.status === "pending"))).approvals[0]!;
    expect(card.prompt).toContain("Which riddle?\nAnswer: Time");
    expect(card.prompt).not.toContain("{");
    await gw.core.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: card.id, approve: true }));
    await eventually(async () => gw.worker.interactionAnswers.some((a) => a.requestId === questionId), Boolean);
    await eventually(() => read(answering.id), (s) => !s.working);
    await gw.core.bots.remove(answering.id);
    gw.worker.emit(threadId, "", { case: "itemStarted", value: { item: { itemId: "bot-bg", status: ItemStatus.IN_PROGRESS, content: { case: "backgroundTask", value: { taskId: "native-bg", description: "Long command" } } } } });
    await eventually(() => gw.runtime.runPromise(GatewayStore.use((s) => s.threadItem(threadId, "bot-bg"))), Boolean);
    expect(await invoke("list_background_tasks", { thread_id: threadId })).toMatchObject({ tasks: [expect.objectContaining({ item_id: "bot-bg" })] });
    await invoke("stop_background_task", { thread_id: threadId, item_id: "bot-bg" }, true);
    await eventually(async () => gw.worker.commands.some((c) => c.case === "stopTask" && c.value.taskId === "native-bg"), Boolean);
    expect(gw.worker.commands.some((c) => c.case === "stopTask" && c.value.taskId === "native-bg")).toBe(true);
    const removable = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/remove" })).workspace!;
    await invoke("remove_workspace", { workspace_id: removable.id }, true);
    expect((await gw.api.getOverview({})).projects.find((p) => p.id === projectId)?.workspaces.some((w) => w.id === removable.id)).toBe(false);
    const disposable = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, providerProfileId: "platform-test", title: "Disposable" })).thread!;
    const refused = await gw.core.bots.create(create(bots.CreateBotRequestSchema, { configuration: config(), clientRequestId: Bun.randomUUIDv7() }));
    const token = Bun.randomUUIDv7();
    requested.set(token, { name: "delete_thread", args: { thread_id: disposable.id } });
    await gw.core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: refused.id, text: token, clientRequestId: token }));
    const waiting = await eventually(() => read(refused.id), (s) => s.approvals.some((a) => a.status === "pending"));
    expect((await gw.api.getThread({ threadId: disposable.id })).thread?.id).toBe(disposable.id);
    await gw.core.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: waiting.approvals[0]!.id, approve: false }));
    await eventually(() => read(refused.id), (s) => !s.working);
    expect((await gw.api.getThread({ threadId: disposable.id })).thread?.id).toBe(disposable.id);
    const autoDisposable = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, providerProfileId: "platform-test", title: "Auto disposable" })).thread!;
    // Full auto: the destructive action runs with no card.
    await invoke("delete_thread", { thread_id: autoDisposable.id }, false, "full_auto");
    expect((await gw.api.listThreads({ includeArchived: true })).threads.some((t) => t.id === autoDisposable.id)).toBe(false);
    await invoke("delete_thread", { thread_id: disposable.id }, true);
    expect((await gw.api.listThreads({ includeArchived: true })).threads.some((t) => t.id === disposable.id)).toBe(false);
    const project = (await gw.api.createProject({ name: "Archive me" })).project!;
    const placement = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo/archive" })).workspace!;
    const archivedThread = (await gw.api.createThread({ projectId: project.id, workspaceId: placement.id, provider: Provider.CODEX, title: "Archive with project" })).thread!;
    const archivedSchedule = (await gw.api.createSchedule({ target: "new_thread", prompt: "Cancelled with project", when: { case: "cron", value: "0 * * * *" }, newThread: { projectId: project.id, placement: "specific", workspaceId: placement.id, provider: Provider.CODEX, providerProfileId: "platform-test", permissionMode: PermissionMode.READ_ONLY } })).schedule!;
    await invoke("archive_project", { project_id: project.id }, true);
    expect((await gw.api.getOverview({})).projects.some((p) => p.id === project.id)).toBe(false);
    expect((await gw.api.getThread({ threadId: archivedThread.id })).thread?.archivedAt).toBeDefined();
    expect((await gw.api.listSchedules({ projectId: project.id, includeFinished: true })).schedules.find((s) => s.id === archivedSchedule.id)?.status).toBe("cancelled");
  }, 30_000);

  test("foreign owners cannot list or mutate projects, workspaces, workers, threads or schedules", async () => {
    const foreignUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("foreign@example.test", "Foreign")));
    const foreign = new GatewayCore({ runtime: gw.runtime, userId: foreignUser, instanceId: "foreign" });
    const p = await foreign.createProject("Foreign project");
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "Foreign worker", ownerUserId: foreignUser })));
    await gw.runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(worker.workerId, { allowedRoots: ["/foreign"] }, foreignUser)));
    const workspace = await gw.runtime.runPromise(GatewayStore.use((s) => s.createWorkspace({ projectId: p.id, workerId: worker.workerId, rootPath: "/foreign", label: "" })));
    const thread = await foreign.createThread(create(ui.CreateThreadRequestSchema, { projectId: p.id, workspaceId: workspace.id, provider: Provider.CODEX }));
    const schedule = await foreign.createSchedule(create(ui.CreateScheduleRequestSchema, { threadId: thread.id, prompt: "foreign", when: { case: "cron", value: "0 * * * *" } }));
    expect((await invoke<{ id: string }[]>("list_projects")).some((r) => r.id === p.id)).toBe(false);
    expect((await invoke<{ id: string }[]>("list_workers")).some((r) => r.id === worker.workerId)).toBe(false);
    expect(await invoke("rename_project", { project_id: p.id, name: "Stolen" })).toHaveProperty("error");
    expect(await invoke("add_workspace", { project_id: p.id, worker_id: gw.workerId, root_path: "/repo" })).toHaveProperty("error");
    expect(await invoke("list_directory", { worker_id: worker.workerId, path: "/foreign" })).toHaveProperty("error");
    expect(await invoke("interrupt_thread", { thread_id: thread.id })).toHaveProperty("error");
    expect(await invoke("get_thread", { thread_id: thread.id })).toHaveProperty("error");
    expect(await invoke("set_schedule_status", { schedule_id: schedule.id, status: "paused" })).toHaveProperty("error");
    expect((await foreign.getThread(thread.id)).title).toBe(thread.title);
    await foreign.link.shutdown();
  }, 30_000);

  test("rollback mid-action and a new gateway after commit replay the same durable call without duplicate projects", async () => {
    await gw.core.bots.stop();
    const bot = await gw.core.bots.create(create(bots.CreateBotRequestSchema, { configuration: config(), clientRequestId: Bun.randomUUIDv7() }));
    await gw.runtime.runPromise(BotStore.use((s) => s.enqueue(gw.userId, bot.id, "restart", Bun.randomUUIDv7())));
    const turn = (await gw.runtime.runPromise(BotStore.use((s) => s.claim(gw.userId))))!;
    const spec = PLATFORM_TOOLS.find((t) => t.name === "create_project")!;
    const call = await gw.runtime.runPromise(BotStore.use((s) => s.planCall(turn, "restart-call", spec, { name: "Atomic restart project" })));
    const options = { runtime: gw.runtime, userId: gw.userId, instanceId: "restart-core" };
    const original = gw.core.createProject.bind(gw.core);
    gw.core.createProject = async (name) => { await original(name); throw new Error("fixture crash after insert before result"); };
    expect(await botPlatform(gw.core, options, turn, call)).toHaveProperty("error");
    gw.core.createProject = original;
    expect((await gw.api.getOverview({})).projects.some((p) => p.name === "Atomic restart project")).toBe(false);
    await gw.runtime.runPromise(BotStore.use((s) => s.release(turn)));
    const restarted = new GatewayCore(options);
    const reclaimed = (await restarted.bots.run((s) => s.claim(gw.userId)))!;
    const result = await botPlatform(restarted, options, reclaimed, call);
    expect(result).toHaveProperty("id");
    await restarted.bots.run((s) => s.release(reclaimed));
    const resumed = (await restarted.bots.run((s) => s.claim(gw.userId)))!;
    expect(await botPlatform(new GatewayCore(options), options, resumed, call)).toEqual(result);
    expect((await gw.api.getOverview({})).projects.filter((p) => p.name === "Atomic restart project")).toHaveLength(1);
    await restarted.bots.run((s) => s.finish(resumed, "completed", "Recovered"));
  }, 15_000);
});
