import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, InteractionKind, PermissionMode } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import type { JsonObject } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually } from "./support/gateway.ts";
import { botsSuite, lastInput, reply, tool } from "./support/bots.ts";

describe.skipIf(!dockerAvailable)("owner-scoped bot approval rules through gateway", () => {
  const { suite, add, read, settled, send, restart } = botsSuite();

  const pending = async (id: string) =>
    (
      await eventually(
        () => read(id),
        (s) => s.approvals.some((a) => a.status === "pending"),
        10_000,
      )
    ).approvals.find((a) => a.status === "pending")!;

  const useTool = (name: string, args: JsonObject = {}) => {
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" ||
      lastInput(i).startsWith("Thread ") ||
      lastInput(i).startsWith("Message from")
        ? reply("Done")
        : tool(name, args);
  };

  const answer = (card: bots.BotApproval, ruleOptionId = "") =>
    suite.gw.api.answerBotApproval({
      approvalId: card.id,
      approve: true,
      ruleOptionId,
    });

  test("Always allow binds exactly the shown connector account; revocation and restart keep enforcement", async () => {
    const server = (await suite.gw.api.listBotMcpServers({})).servers.find((s) => s.id === suite.serverId)!;

    const other = (
      await suite.gw.api.saveBotMcpServer({ name: "Other account", url: server.url, transport: "http", enabled: true })
    ).server!;

    const bot = await add("Account rules", { mcpServerIds: [server.id, other.id] });
    let account = server.id;
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Done")
        : tool(i.tools.find((t) => t.serverId === account)!.name, { text: lastInput(i) });
    await send(bot.id, "First view");
    const card = await pending(bot.id);
    expect(card.ruleOptions).toHaveLength(2);
    const shown = card.ruleOptions[0]!;
    expect(shown).toMatchObject({
      kind: "connector",
      targetId: server.id,
      toolName: "",
      label: "Custom MCP server · Notion",
    });
    await expect(answer(card, Bun.randomUUIDv7())).rejects.toThrow();
    expect((await suite.gw.api.listBotApprovalRules({ botId: bot.id })).rules).toHaveLength(0);
    await Promise.all([answer(card, shown.id), answer(card, shown.id)]);
    await settled(bot.id);
    const rules = (await suite.gw.api.listBotApprovalRules({ botId: bot.id })).rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: shown.id,
      kind: shown.kind,
      targetId: shown.targetId,
      toolName: shown.toolName,
      label: shown.label,
      source: "approval_card",
    });
    expect(rules[0]!.createdAt).toBeDefined();
    const before = suite.writes;
    await send(bot.id, "Second view");
    const next = await settled(bot.id);
    expect(suite.writes).toBe(before + 1);
    expect(next.approvals.at(-1)?.allowedByRule?.id).toBe(shown.id);
    account = other.id;
    await send(bot.id, "Other account");
    const wrong = await pending(bot.id);
    expect(wrong.allowedByRule).toBeUndefined();
    await suite.gw.api.answerBotApproval({ approvalId: wrong.id, approve: false });
    await settled(bot.id);
    const stranger = await add("No shared rules", { mcpServerIds: [server.id] });
    account = server.id;
    await send(stranger.id, "Other bot");
    expect((await pending(stranger.id)).allowedByRule).toBeUndefined();
    await suite.current.bots.interrupt(stranger.id);
    await restart();
    await suite.current.bots.deleteRule(
      create(bots.DeleteBotApprovalRuleRequestSchema, { botId: bot.id, ruleId: shown.id }),
    );
    await send(bot.id, "After revoke");
    expect((await pending(bot.id)).allowedByRule).toBeUndefined();
    await suite.current.bots.interrupt(bot.id);
  }, 30_000);

  test("rules cannot be read, saved, or revoked by another owner", async () => {
    const bot = await add("Private rules", { approvalPolicy: "always" });
    useTool("schedule_wakeup", { run_at: new Date(Date.now() + 3600_000).toISOString(), prompt: "Later" });
    await send(bot.id, "Reminder");
    const card = await pending(bot.id);

    const user = await suite.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("approval-other@test.local", "Other")),
    );

    const foreign = new GatewayCore({ runtime: suite.gw.runtime, userId: user, instanceId: Bun.randomUUIDv7() });
    await expect(
      foreign.bots.answer(
        create(bots.AnswerBotApprovalRequestSchema, {
          approvalId: card.id,
          approve: true,
          ruleOptionId: card.ruleOptions[0]!.id,
        }),
      ),
    ).rejects.toThrow();
    await answer(card, card.ruleOptions[0]!.id);
    await settled(bot.id);
    await expect(foreign.bots.rules(bot.id)).rejects.toThrow();
    await expect(
      foreign.bots.deleteRule(
        create(bots.DeleteBotApprovalRuleRequestSchema, { botId: bot.id, ruleId: card.ruleOptions[0]!.id }),
      ),
    ).rejects.toThrow();
  }, 20_000);

  test("a specific connector tool rule never allows another tool on that account", async () => {
    const bot = await add("One tool", { mcpServerIds: [suite.serverId] });
    let name = "send_external_message";
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Done")
        : tool(i.tools.find((t) => t.serverId === suite.serverId && t.remoteName === name)!.name, { text: "View" });
    await send(bot.id, "Allow one tool");
    const card = await pending(bot.id);
    const shown = card.ruleOptions[1]!;
    expect(shown.toolName).toBe(name);
    await answer(card, shown.id);
    await settled(bot.id);
    await send(bot.id, "Use again");
    expect((await settled(bot.id)).approvals.at(-1)?.allowedByRule?.id).toBe(shown.id);
    name = "update_external_view";
    await send(bot.id, "Use another tool");
    expect((await pending(bot.id)).allowedByRule).toBeUndefined();
    await suite.current.bots.interrupt(bot.id);
  }, 20_000);

  test("protected self changes ignore even a stored broad rule and full auto", async () => {
    const bot = await add("Protected owner", { approvalPolicy: "full_auto" });
    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO bot_approval_rules(id,bot_id,owner_user_id,kind,label,source)
        SELECT ${Bun.randomUUIDv7()}::uuid,id,owner_user_id,'update_self','Updating this bot','approval_card' FROM bots WHERE id=${bot.id}::uuid`;
      }),
    );
    useTool("update_self", { model: "gpt-6.1-sol" });
    await send(bot.id, "Change model");
    const card = await pending(bot.id);
    expect(card.ruleOptions).toHaveLength(0);
    expect(card.allowedByRule).toBeUndefined();
    await suite.current.bots.interrupt(bot.id);
    useTool("update_self", { rules: [{ kind: "connector", target_id: suite.serverId }] });
    await send(bot.id, "Create a rule from text");
    const forged = await pending(bot.id);
    expect(forged.ruleOptions).toHaveLength(0);
    expect(await suite.current.bots.rules(bot.id)).toHaveLength(1);
    await suite.current.bots.interrupt(bot.id);
  }, 20_000);

  test("thread and bot destinations match exact ids, and self permission changes always ask", async () => {
    const target = await add("Trusted destination");
    const other = await add("Other destination");
    const bot = await add("Destination rules", { approvalPolicy: "always" });
    let destination = target.id;
    suite.model = async (i) =>
      i.configuration.name !== "Destination rules" ||
      i.messages.at(-1)?.role === "tool" ||
      lastInput(i).startsWith("Message from")
        ? reply("Done")
        : tool("send_bot_message", { bot_id: destination, text: "Hello" });
    await send(bot.id, "First");
    const card = await pending(bot.id);
    expect(card.ruleOptions[0]?.targetId).toBe(target.id);
    await answer(card, card.ruleOptions[0]!.id);
    await settled(bot.id);
    await send(bot.id, "Same destination");
    expect((await settled(bot.id)).approvals.some((a) => a.allowedByRule?.id === card.ruleOptions[0]!.id)).toBe(true);
    destination = other.id;
    await send(bot.id, "Other destination");
    expect((await pending(bot.id)).allowedByRule).toBeUndefined();
    await suite.current.bots.interrupt(bot.id);
    useTool("update_self", { approval_policy: "full_auto" });
    await send(bot.id, "Change permissions");
    expect((await pending(bot.id)).ruleOptions).toHaveLength(0);
    await suite.current.bots.interrupt(bot.id);
  }, 25_000);
});

describe.skipIf(!dockerAvailable)("bot-started thread approvals", () => {
  const { suite, add, read, settled, send } = botsSuite();
  test("owner defaults and bot overrides reach the worker, with a visible computer ceiling", async () => {
    const settings = (await suite.gw.api.getSettings({})).user!;
    await suite.gw.api.updateUserSettings({
      expectedVersion: settings.version,
      threadDefaults: { permissionMode: PermissionMode.FULL_ACCESS },
    });
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" || lastInput(i).startsWith("Thread ")
        ? reply("Started")
        : tool("start_thread", {
            project_id: suite.projectId,
            workspace_id: suite.workspaceId,
            provider: "codex",
            provider_instance: "native",
            prompt: "Check permissions",
            title: i.configuration.name,
          });

    const modes: [string, PermissionMode][] = [
      ["same_bot", PermissionMode.FULL_AUTO],
      ["user_default", PermissionMode.FULL_AUTO],
      ["ask", PermissionMode.ASK],
      ["read_only", PermissionMode.READ_ONLY],
      ["accept_edits", PermissionMode.ACCEPT_EDITS],
      ["full_auto", PermissionMode.FULL_AUTO],
      ["full_access", PermissionMode.FULL_AUTO],
    ];

    try {
      for (const [threadPermission, expected] of modes) {
        const bot = await add(`Mode ${threadPermission}`, { approvalPolicy: "full_auto", threadPermission });
        await send(bot.id, "Start with my setting");
        await settled(bot.id);

        const threads = await eventually(
          () => suite.gw.api.listThreads({ projectId: suite.projectId }),
          (r) => r.threads.some((t) => t.title === `Mode ${threadPermission}`),
        );

        const thread = threads.threads.find((t) => t.title === `Mode ${threadPermission}`)!;
        expect(thread.permissionMode).toBe(expected);

        if (["same_bot", "user_default", "full_access"].includes(threadPermission))
          expect(thread.permissionModeNote).toContain("limits Full access to Full auto");

        const ready = await eventually(
          async () => suite.gw.worker.created.find((t) => t.threadId === thread.id),
          Boolean,
        );

        expect(ready?.permissionMode).toBe(expected);
      }
    } finally {
      const current = (await suite.gw.api.getSettings({})).user!;
      await suite.gw.api.updateUserSettings({
        expectedVersion: current.version,
        threadDefaults: settings.threadDefaults,
      });
    }
  }, 20_000);

  test("a bot inherits Full access on a capable worker and a fixed override can narrow it", async () => {
    const settings = (await suite.gw.api.getSettings({})).user!;
    await suite.gw.api.updateUserSettings({
      expectedVersion: settings.version,
      threadDefaults: { permissionMode: PermissionMode.FULL_ACCESS },
    });
    const added = await suite.gw.addWorker("Bot full access");

    const worker = await suite.gw.connect(added.workerId, added.credential, undefined, {
      hello: { capabilities: ["full_access"] },
    });

    await eventually(
      () => suite.gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === added.workerId && w.appliedVersion > 0n),
    );

    const workspace = (
      await suite.gw.api.createWorkspace({
        projectId: suite.projectId,
        workerId: added.workerId,
        rootPath: "/repo",
        label: "Full access",
      })
    ).workspace!;

    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" || lastInput(i).startsWith("Thread ")
        ? reply("Started")
        : tool("start_thread", {
            project_id: suite.projectId,
            workspace_id: workspace.id,
            provider: "codex",
            provider_instance: "native",
            prompt: "Check",
            title: i.configuration.name,
          });

    try {
      for (const [threadPermission, expected] of [
        ["user_default", PermissionMode.FULL_ACCESS],
        ["read_only", PermissionMode.READ_ONLY],
      ] as const) {
        const bot = await add(`Capable ${threadPermission}`, { approvalPolicy: "full_auto", threadPermission });
        await send(bot.id, "Start");
        await settled(bot.id);

        const thread = (await suite.gw.api.listThreads({ projectId: suite.projectId })).threads.find(
          (t) => t.title === bot.configuration!.name,
        )!;

        expect(thread.permissionMode).toBe(expected);
        expect(thread.permissionModeNote).toBe("");
        expect((await worker.createdThread(thread.id))?.permissionMode).toBe(expected);
      }
    } finally {
      const current = (await suite.gw.api.getSettings({})).user!;
      await suite.gw.api.updateUserSettings({
        expectedVersion: current.version,
        threadDefaults: settings.threadDefaults,
      });
    }
  }, 20_000);

  test("project rule starts only matching threads; one native request can be answered in either chat", async () => {
    suite.gw.worker.holdTurns = true;
    const bot = await add("Thread owner");
    let project = suite.projectId;
    let workspace = suite.workspaceId;
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" || lastInput(i).startsWith("Thread ")
        ? reply("Started")
        : tool("start_thread", {
            project_id: project,
            workspace_id: workspace,
            provider: "codex",
            provider_instance: "native",
            model: "gpt-6.1-sol",
            prompt: "Wait for approval",
            title: "Bot thread",
          });
    await send(bot.id, "Start");

    const waiting = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    const card = waiting.approvals[0]!;
    expect(card.ruleOptions[0]?.targetId).toBe(project);
    await suite.gw.api.answerBotApproval({ approvalId: card.id, approve: true, ruleOptionId: card.ruleOptions[0]!.id });
    await settled(bot.id);

    const thread = (await suite.gw.api.listThreads({ projectId: project })).threads.find(
      (t) => t.title === "Bot thread",
    )!;

    expect(thread.permissionMode).toBe(PermissionMode.ASK);
    const snapshot = await suite.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(thread.id)));
    const requestId = Bun.randomUUIDv7();
    suite.gw.worker.ask({
      requestId,
      threadId: thread.id,
      turnId: snapshot.turns[0]!.id,
      kind: InteractionKind.PERMISSION,
      toolName: "shell",
      requestJson: '{"command":"git status"}',
    });

    const mirrored = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.requestId === requestId),
    );

    expect(mirrored.approvals.find((a) => a.id === requestId)?.threadId).toBe(thread.id);

    const foreignUser = await suite.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("thread-other@test.local", "Other")),
    );

    const foreign = new GatewayCore({ runtime: suite.gw.runtime, userId: foreignUser, instanceId: Bun.randomUUIDv7() });
    await expect(
      foreign.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: requestId, approve: true })),
    ).rejects.toThrow();

    const outcomes = await Promise.allSettled([
      suite.gw.api.answerBotApproval({ approvalId: requestId, approve: true }),
      suite.gw.api.answerInteraction({ requestId, allow: false }),
    ]);

    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    await eventually(
      async () => suite.gw.worker.interactionAnswers.filter((a) => a.requestId === requestId).length,
      (n) => n === 1,
    );
    expect(suite.gw.worker.interactionAnswers.filter((a) => a.requestId === requestId)).toHaveLength(1);
    const resolved = await read(bot.id);
    expect(resolved.approvals.find((a) => a.id === requestId)?.status).not.toBe("pending");
    const before = resolved.approvals.length;
    await send(bot.id, "Start another here");
    expect((await settled(bot.id)).approvals.some((a) => a.allowedByRule?.id === card.ruleOptions[0]!.id)).toBe(true);
    expect((await read(bot.id)).approvals).toHaveLength(before + 1);
    const other = (await suite.gw.api.createProject({ name: "Other project" })).project!;
    project = other.id;
    workspace = (
      await suite.gw.api.createWorkspace({ projectId: project, workerId: suite.gw.workerId, rootPath: "/other" })
    ).workspace!.id;
    await send(bot.id, "Start elsewhere");

    const unmatched = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending" && !a.requestId),
    );

    expect(unmatched.approvals.find((a) => a.status === "pending")?.allowedByRule).toBeUndefined();
    await suite.current.bots.interrupt(bot.id);
    suite.gw.worker.holdTurns = false;
  }, 30_000);

  test("same-bot connector rules apply inside a started thread but never replace worker grants", async () => {
    suite.gw.worker.holdTurns = true;
    const bot = await add("Inherited connector", { mcpServerIds: [suite.serverId] });
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Done")
        : tool(i.tools.find((t) => t.source === "mcp")!.name, { text: "First" });
    await send(bot.id, "Allow account");

    const initial = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    const option = initial.approvals.find((a) => a.status === "pending")!.ruleOptions[0]!;
    await suite.gw.api.answerBotApproval({
      approvalId: initial.approvals[0]!.id,
      approve: true,
      ruleOptionId: option.id,
    });
    await settled(bot.id);
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" || lastInput(i).startsWith("Thread ")
        ? reply("Started")
        : tool("start_thread", {
            project_id: suite.projectId,
            workspace_id: suite.workspaceId,
            provider: "codex",
            provider_instance: "native",
            prompt: "Wait",
            title: "Inherited account thread",
          });
    await send(bot.id, "Start");

    const waiting = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.gw.api.answerBotApproval({
      approvalId: waiting.approvals.find((a) => a.status === "pending")!.id,
      approve: true,
    });
    await settled(bot.id);

    const thread = (await suite.gw.api.listThreads({ projectId: suite.projectId })).threads.find(
      (t) => t.title === "Inherited account thread",
    )!;

    const snapshot = await suite.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(thread.id)));
    let account = (await suite.gw.api.listConnectors({})).accounts.find((a) => a.id === suite.serverId)!;
    account = (
      await suite.gw.api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: account.revision,
        allWorkers: true,
        botIds: [bot.id],
      })
    ).account!;

    const connector = (await suite.current.connectors.tools(suite.gw.userId, { workerId: suite.gw.workerId })).find(
      (t) => t.accountId === account.id,
    )!;

    const requestId = Bun.randomUUIDv7();

    const call = (callId: string) =>
      suite.gw.worker.callTool({
        threadId: thread.id,
        turnId: snapshot.turns[0]!.id,
        connectorAccountId: account.id,
        tool: connector.name,
        args: { text: "Inside" },
        callId,
      });

    expect((await call(requestId)).isError).toBe(false);
    expect((await read(bot.id)).approvals.find((a) => a.id === requestId)?.allowedByRule?.id).toBe(option.id);
    await suite.gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, threadPermission: "ask" } });
    const narrowedId = Bun.randomUUIDv7();
    const narrowed = call(narrowedId);
    await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.id === narrowedId && a.status === "pending"),
    );
    await suite.gw.api.answerBotApproval({ approvalId: narrowedId, approve: false });
    expect((await narrowed).isError).toBe(true);
    await suite.gw.api.updateBot({
      botId: bot.id,
      configuration: { ...bot.configuration!, threadPermission: "same_bot" },
    });
    expect((await call(Bun.randomUUIDv7())).isError).toBe(false);
    await suite.gw.api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: account.revision,
      botIds: [bot.id],
    });
    expect((await call(Bun.randomUUIDv7())).isError).toBe(true);
    suite.gw.worker.finish(thread.id, snapshot.turns[0]!.id);

    const stopped = await eventually(
      () => suite.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(thread.id))),
      (s) => s.turns[0]?.status === "completed",
    );

    expect(stopped.turns[0]?.status).toBe("completed");
    suite.gw.worker.holdTurns = false;
  }, 20_000);
});
