/** Owner-only live changes cross the UI RPC, worker link, ordered journal and gateway authorization. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { fromJson } from "@bufbuild/protobuf";
import { AgentTool, InteractionKind, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { CLAUDE_LIVE_PERMISSIONS_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { SqlClient } from "effect/sql";
import { fakeConnector } from "./support/connector.ts";
import { busState } from "../../apps/gateway/src/core/agent-bus-context.ts";
import { eventually, failure, startTestGateway, type CommandHandler, type TestGateway } from "./support/gateway.ts";

const capabilities = [CLAUDE_LIVE_PERMISSIONS_CAPABILITY, "full_access", "agent_tools_v1"];

const models = [
  { provider: Provider.CLAUDE, profileId: "native", models: [{ id: "claude-test", isDefault: true }] },
  { provider: Provider.CODEX, profileId: "native", models: [{ id: "codex-test", isDefault: true }] },
];

describe.skipIf(!dockerAvailable)("live Claude permissions through gateway and scripted worker", () => {
  let gw: TestGateway;
  let connector: ReturnType<typeof fakeConnector>;
  let projectId = "";

  const query = <A extends object>(statement: string, params: string[] = []) =>
    gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(statement, params)));

  const apply: CommandHandler = (value, reply) => {
    if (!("threadId" in value && "turnId" in value && "permissionMode" in value))
      throw new Error("Expected live turn permissions");
    gw.worker.emit(value.threadId, value.turnId, {
      case: "turnPermissionsChanged",
      value: { permissionMode: value.permissionMode },
    });
    reply(true);
  };

  beforeAll(async () => {
    connector = fakeConnector();
    gw = await startTestGateway({ worker: { claude: true, models, hello: { capabilities } } });
    gw.worker.holdTurns = true;
    gw.worker.handlers.set("updateTurnPermissions", apply);
    projectId = (await gw.api.createProject({ name: "Live permissions" })).project!.id;
  }, 60_000);
  afterAll(async () => {
    await connector?.close();
    await gw?.close();
  }, 30_000);

  async function running(
    mode = PermissionMode.ASK,
    workerId = gw.workerId,
    worker = gw.worker,
    provider = Provider.CLAUDE,
  ) {
    const workspace = (
      await gw.api.createWorkspace({ projectId, workerId, rootPath: `/repo/live-permissions-${crypto.randomUUID()}` })
    ).workspace!;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId: workspace.id,
        provider,
        model: provider === Provider.CLAUDE ? "claude-test" : "codex-test",
        permissionMode: mode,
      })
    ).thread!;

    await worker.createdThread(thread.id);
    worker.holdTurns = true;

    const turn = (await gw.api.sendMessage({ threadId: thread.id, text: "Work", clientRequestId: crypto.randomUUID() }))
      .turn!;

    expect(
      await eventually(
        () => gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(thread.id))),
        (current) => current?.id === turn.id,
      ),
    ).toBeDefined();

    return { threadId: thread.id, turnId: turn.id };
  }

  const change = (scope: { threadId: string; turnId: string }, permissionMode: PermissionMode) =>
    gw.api.updateTurnPermissions({ ...scope, permissionMode });

  const pending = (scope: { threadId: string }) =>
    gw.runtime.runPromise(GatewayStore.use((s) => s.pendingInteractions(scope.threadId)));

  async function ask(scope: { threadId: string; turnId: string }, kind = InteractionKind.PERMISSION) {
    const requestId = crypto.randomUUID();
    gw.worker.ask({
      ...scope,
      requestId,
      kind,
      toolName: kind === InteractionKind.PERMISSION ? "Bash" : "AskUserQuestion",
      requestJson: "{}",
    });
    expect(
      await eventually(
        () => pending(scope),
        (rows) => rows.some((r) => r.requestId === requestId),
      ),
    ).toContainEqual(expect.objectContaining({ requestId }));

    return requestId;
  }

  function hold() {
    const received = Promise.withResolvers<void>();
    let complete = () => {};

    gw.worker.handlers.set("updateTurnPermissions", (value, reply) => {
      complete = () => apply(value, reply);
      received.resolve();
    });

    return {
      received: received.promise,
      complete: () => complete(),
      restore: () => gw.worker.handlers.set("updateTurnPermissions", apply),
    };
  }

  test("capability is exposed; owner, enum and exact active turn are enforced before dispatch", async () => {
    const scope = await running();
    const before = gw.worker.commands.length;
    const owner = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));
    const foreignId = crypto.randomUUID();
    await query(
      `INSERT INTO threads (id,project_id,owner_user_id,kind,root_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,title,status)
       SELECT $1::uuid,project_id,$2::uuid,'main',$1::uuid,0,runtime,provider,worker_id,workspace_id,cwd,'Private thread','idle'
         FROM threads WHERE id=$3::uuid`,
      [foreignId, owner, scope.threadId],
    );
    expect(await failure(change({ ...scope, threadId: foreignId }, PermissionMode.FULL_ACCESS))).toContain("not found");
    expect(await failure(change({ ...scope, threadId: crypto.randomUUID() }, PermissionMode.FULL_ACCESS))).toContain(
      "not found",
    );
    expect(await failure(change({ ...scope, turnId: crypto.randomUUID() }, PermissionMode.FULL_ACCESS))).toContain(
      "running",
    );
    expect(await failure(change(scope, PermissionMode.UNSPECIFIED))).toContain("Choose a permission mode");
    expect(
      await failure(
        gw.api.updateTurnPermissions(fromJson(ui.UpdateTurnPermissionsRequestSchema, { ...scope, permissionMode: 99 })),
      ),
    ).toContain("unknown permission mode");
    expect(gw.worker.commands).toHaveLength(before);
    expect((await gw.api.getOverview({})).workers.find((w) => w.id === gw.workerId)?.claudeLivePermissions).toBe(true);
  });

  test("a non-Claude running turn is refused before reaching the worker", async () => {
    const scope = await running(PermissionMode.ASK, gw.workerId, gw.worker, Provider.CODEX);
    const before = gw.worker.commands.length;
    expect(await failure(change(scope, PermissionMode.FULL_ACCESS))).toContain("only for Claude");
    expect(gw.worker.commands).toHaveLength(before);
  });

  test("legacy and opted-out workers refuse without fallback; offline workers require reconnect", async () => {
    for (const caps of [[], [CLAUDE_LIVE_PERMISSIONS_CAPABILITY]]) {
      const edge = await gw.addWorker("Limited worker");

      const worker = await gw.connect(edge.workerId, edge.credential, undefined, {
        claude: true,
        models,
        hello: { capabilities: caps },
      });

      const scope = await running(PermissionMode.ASK, edge.workerId, worker);
      const before = worker.commands.length;
      expect(await failure(change(scope, PermissionMode.FULL_ACCESS))).toContain(
        caps.length ? "Full access is not available" : "Update this thread's worker",
      );
      expect(worker.commands).toHaveLength(before);
      worker.link.close();
      await eventually(
        async () => gw.core.online.has(edge.workerId),
        (online) => !online,
      );
      expect(await failure(change(scope, PermissionMode.ASK))).toContain("offline");
    }
  });

  test("Full access durably answers permissions present before and during the switch; questions and denials stay intact", async () => {
    const scope = await running();
    const expired = await ask(scope);
    await query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1::uuid", [expired]);
    const permission = await ask(scope);
    const denied = await ask(scope);
    const question = await ask(scope, InteractionKind.QUESTION);
    const elicitation = await ask(scope, InteractionKind.ELICITATION);
    await gw.api.answerInteraction({ requestId: denied, allow: false });
    const gate = hold();
    const switching = change(scope, PermissionMode.FULL_ACCESS);
    await gate.received;

    try {
      const arriving = await ask(scope);
      gate.complete();
      expect((await switching).turn?.permissionMode).toBe(PermissionMode.FULL_ACCESS);
      expect((await pending(scope)).map((r) => r.requestId).sort()).toEqual([question, elicitation].sort());
      expect(
        await query("SELECT id,status,answered_by FROM interaction_requests WHERE id=ANY($1::uuid[]) ORDER BY id", [
          `{${[expired, permission, arriving, denied].join(",")}}`,
        ]),
      ).toEqual(
        [expired, permission, arriving, denied].sort().map((id) => ({
          id,
          status: id === expired ? "expired" : id === denied ? "declined" : "allowed",
          answered_by: id === expired ? null : gw.userId,
        })),
      );

      const counts = await query<{ ends: number }>(
        "SELECT count(*)::int AS ends FROM thread_events WHERE thread_id=$1::uuid AND kind='item_completed' AND item_id=ANY($2::text[])",
        [scope.threadId, `{interaction-${expired},interaction-${permission},interaction-${arriving}}`],
      );

      expect(counts).toEqual([{ ends: 3 }]);
      expect((await gw.api.getThread({ threadId: scope.threadId })).thread?.permissionMode).toBe(PermissionMode.ASK);
    } finally {
      gate.complete();
      gate.restore();
      await switching;
    }
  });

  test("Full auto never autoapproves a previously unconfined native Bash request", async () => {
    const scope = await running();
    const requestId = await ask(scope);
    await change(scope, PermissionMode.FULL_AUTO);
    expect((await pending(scope)).map((r) => r.requestId)).toEqual([requestId]);
    expect(gw.worker.interactionResponses.has(requestId)).toBe(false);
  });

  test("failed switch preserves the applied mode and has no durable command to replay", async () => {
    const scope = await running();
    gw.worker.handlers.set("updateTurnPermissions", (_value, reply) =>
      reply(false, { errorCode: "HARNESS_ERROR", errorMessage: "SDK refused live permissions" }),
    );

    try {
      expect(await failure(change(scope, PermissionMode.FULL_ACCESS))).toContain("SDK refused");
      expect(
        (await gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(scope.threadId))))?.permission_mode,
      ).toBe("ASK");
      expect(await query("SELECT id FROM worker_commands WHERE kind='updateTurnPermissions'")).toEqual([]);
    } finally {
      gw.worker.handlers.set("updateTurnPermissions", apply);
    }
  });

  test("rapid picks serialize and only the acknowledged old turn changes when the next turn starts", async () => {
    const scope = await running();
    const gate = hold();
    const first = change(scope, PermissionMode.FULL_ACCESS);
    await gate.received;
    const second = change(scope, PermissionMode.READ_ONLY);
    gate.restore();

    try {
      gate.complete();
      expect((await first).turn?.permissionMode).toBe(PermissionMode.FULL_ACCESS);
      expect((await second).turn?.permissionMode).toBe(PermissionMode.READ_ONLY);
      const finishing = hold();
      const last = change(scope, PermissionMode.FULL_ACCESS);
      await finishing.received;
      gw.worker.finish(scope.threadId, scope.turnId);
      await eventually(
        () => gw.api.getThread({ threadId: scope.threadId }),
        (r) => r.thread?.status === "idle",
      );

      const next = (
        await gw.api.sendMessage({ threadId: scope.threadId, text: "Next", clientRequestId: crypto.randomUUID() })
      ).turn!;

      expect(await eventually(async () => gw.worker.turnModes.has(next.id), Boolean)).toBe(true);
      finishing.complete();
      expect((await last).turn).toMatchObject({
        id: scope.turnId,
        status: "completed",
        permissionMode: PermissionMode.FULL_ACCESS,
      });
      expect(gw.worker.turnModes.get(next.id)?.turn).toBe(PermissionMode.ASK);
      expect(
        (await gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(scope.threadId))))?.permission_mode,
      ).toBe("ASK");
      finishing.restore();
    } finally {
      gate.complete();
      gate.restore();
      await Promise.allSettled([first, second]);
    }
  });

  async function automation(scope: { threadId: string; turnId: string }) {
    return gw.worker.callTool({
      ...scope,
      tool: "authorize_local_automation",
      args: { tool: AgentTool.BROWSER, name: "browser_click", arguments: "{}" },
      expiresAt: new Date(Date.now() + 15_000),
    });
  }

  test("gateway automation waits for a restrictive switch and pending automation advances after elevation", async () => {
    gw.worker.link.send({
      case: "agentToolsReport",
      value: { tools: [{ tool: AgentTool.BROWSER, installed: true, ready: true, version: "0.43.0" }] },
    });
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.find((w) => w.id === gw.workerId)?.agentTools.length === 3,
    );
    await gw.api.setAgentToolEnabled({ workerId: gw.workerId, tool: AgentTool.BROWSER, enabled: true });
    const scope = await running(PermissionMode.FULL_AUTO);
    const gate = hold();
    const switching = change(scope, PermissionMode.READ_ONLY);
    await gate.received;
    let answered = false;

    const blocked = automation(scope).then((result) => {
      answered = true;

      return result;
    });

    try {
      await gw.api.getThread({ threadId: scope.threadId });
      expect(answered).toBe(false);
      gate.complete();
      await switching;
      expect((await blocked).isError).toBe(true);
    } finally {
      gate.complete();
      gate.restore();
      await Promise.allSettled([switching, blocked]);
    }

    for (const mode of [PermissionMode.FULL_ACCESS, PermissionMode.FULL_AUTO]) {
      const asking = await running();
      const call = automation(asking);
      expect(
        await eventually(
          () => pending(asking),
          (rows) => rows.length === 1,
        ),
      ).toHaveLength(1);
      await change(asking, mode);
      expect((await call).isError).toBe(false);
      expect(await pending(asking)).toEqual([]);
      expect(
        await query("SELECT status FROM interaction_requests WHERE thread_id=$1::uuid", [asking.threadId]),
      ).toEqual([{ status: "allowed" }]);
    }
  }, 30_000);

  test("a connector write approved after a live downgrade is rejected before the MCP call", async () => {
    const account = (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Live permission connector",
        url: connector.url,
        authKind: "headers",
        token: connector.secret,
      })
    ).account!;

    const tools = (await gw.api.testConnector({ accountId: account.id })).tools;
    const write = tools.find((tool) => tool.remoteName === "write_marker")!;
    await gw.api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: account.revision,
      projectIds: [projectId],
    });
    const scope = await running(PermissionMode.ASK);
    const callId = crypto.randomUUID();

    const waiting = gw.worker.callTool({
      ...scope,
      callId,
      connectorAccountId: account.id,
      tool: write.name,
      args: { marker: "must-not-write" },
    });

    await eventually(
      () => pending(scope),
      (rows) => rows.some((row) => row.requestId === callId),
    );
    await change(scope, PermissionMode.READ_ONLY);
    await gw.api.answerInteraction({ requestId: callId, allow: true });
    expect((await waiting).isError).toBe(true);
    expect(connector.calls).toHaveLength(0);
  });

  test("a spawn during a held downgrade waits and inherits the applied Read only mode", async () => {
    const scope = await running(PermissionMode.FULL_ACCESS);
    const gate = hold();
    const switching = change(scope, PermissionMode.READ_ONLY);
    await gate.received;
    const entered = Promise.withResolvers<void>();
    const host = gw.core.bus[busState].host;
    const mutation = host.permissionMutation;

    if (!mutation) throw new Error("Gateway spawn permission serialization is missing");

    const observing = spyOn(host, "permissionMutation").mockImplementation((threadId, perform) => {
      entered.resolve();

      return mutation(threadId, perform);
    });

    const spawning = gw.worker.callTool({
      ...scope,
      tool: "spawn_thread",
      args: { title: "Child after downgrade", prompt: "Read the project", notify: false },
    });

    try {
      await entered.promise;
      expect(await query("SELECT id FROM threads WHERE parent_thread_id=$1::uuid", [scope.threadId])).toEqual([]);
      gate.complete();
      await switching;
      expect((await spawning).isError).toBe(false);
      expect(
        await query("SELECT settings->>'permissionMode' AS mode FROM threads WHERE parent_thread_id=$1::uuid", [
          scope.threadId,
        ]),
      ).toEqual([{ mode: "READ_ONLY" }]);
    } finally {
      observing.mockRestore();
      gate.complete();
      gate.restore();
      await Promise.allSettled([switching, spawning]);
    }
  });
});
