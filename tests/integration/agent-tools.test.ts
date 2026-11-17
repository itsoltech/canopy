/** Automation crosses the real UI RPC and authenticated WorkerLink; screenshots and commands stay transient. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentToolsReportSchema,
  AgentToolCallSchema,
  InteractionKind,
  InteractionRequestSchema,
  Provider,
  PermissionMode,
  ui,
  AgentToolInfoSchema,
  type AgentToolsReport,
} from "@canopy/contracts";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { authorizeLocalAutomation } from "../../apps/gateway/src/core/automation-permissions.ts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";
import { expectLinkedAgentToolRouting } from "./support/agent-tools-linked.ts";
import { expectAgentToolEnablement } from "./support/agent-tools-enable.ts";

const capabilities = ["agent_tools_v1"];
const tools = [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE];
let gateway: TestGateway;
let revision = 0;
const unknownTool = 99 as AgentTool;

const query = <A extends object>(statement: string, params: readonly string[] = []) =>
  gateway.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(statement, params);
    }),
  );

const view = async (id = gateway.workerId) =>
  (await gateway.api.getOverview({})).workers.find((worker) => worker.id === id);

const automation = (worker: ScriptedWorker) =>
  worker.commands.filter(
    (command) =>
      command.case === "runAgentTool" || command.case === "installAgentTool" || command.case === "probeAgentTools",
  );

const code = (result: Promise<unknown>) =>
  result.then(
    () => 0,
    (cause: unknown) => ConnectError.from(cause).code,
  );

const grant = (enabled: boolean, tool = AgentTool.BROWSER, workerId = gateway.workerId) =>
  gateway.api.setAgentToolEnabled({ workerId, tool, enabled });

const run = (operation = "snapshot", workerId = gateway.workerId, tool = AgentTool.BROWSER) =>
  gateway.api.runAgentTool({ workerId, operation: { tool, operation } });

function report(overrides: MessageInitShape<typeof AgentToolInfoSchema> = {}): AgentToolsReport {
  const detail = `Automation report ${++revision}`;

  return create(AgentToolsReportSchema, {
    os: "linux",
    arch: "x64",
    tools: tools.map((tool) =>
      create(AgentToolInfoSchema, {
        tool,
        installed: true,
        ready: true,
        installable: true,
        screenshot: true,
        version: tool === AgentTool.DEVICE ? "0.21.37" : tool === AgentTool.DESKTOP ? "1.3.1" : "0.43.0",
        detail,
        ...overrides,
      }),
    ),
  });
}

async function publish(value = report(), worker = gateway.worker, workerId = gateway.workerId) {
  worker.link.send({ case: "agentToolsReport", value });

  const found = await eventually(
    () => view(workerId),
    (item) => item?.agentTools[0]?.tool?.detail === value.tools[0]?.detail,
  );

  expect(found?.agentTools[0]?.tool?.detail).toBe(value.tools[0]?.detail);

  return value;
}

async function readyWorker(name: string, supported = true) {
  const registered = await gateway.addWorker(name);

  const worker = await gateway.connect(registered.workerId, registered.credential, undefined, {
    hello: { capabilities: supported ? capabilities : [] },
  });

  await eventually(
    () => view(registered.workerId),
    (item) => Boolean(item && item.appliedVersion > 0n),
  );

  return { ...registered, worker };
}

async function heldThread(mode = PermissionMode.ASK, worker = gateway.worker, workerId = gateway.workerId) {
  worker.holdTurns = true;
  const project = (await gateway.api.createProject({ name: "Automation live permission" })).project!;

  const workspace = (
    await gateway.api.createWorkspace({ projectId: project.id, workerId, rootPath: "/repo/automation-live-permission" })
  ).workspace!;

  const thread = (
    await gateway.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      permissionMode: mode,
    })
  ).thread!;

  await worker.createdThread(thread.id);

  const turn = (
    await gateway.api.sendMessage({ threadId: thread.id, text: "Automation", clientRequestId: crypto.randomUUID() })
  ).turn!;

  await eventually(async () => worker.started.has(turn.id), Boolean);

  const running = await eventually(
    () => gateway.runtime.runPromise(GatewayStore.use((store) => store.runningTurn(thread.id))),
    (current) => current?.id === turn.id,
  );

  expect(running?.id).toBe(turn.id);

  return { threadId: thread.id, turnId: turn.id };
}

function authorization(target: { threadId: string; turnId: string }, ttl = 5000, tool = AgentTool.BROWSER) {
  return create(AgentToolCallSchema, {
    ...target,
    callId: crypto.randomUUID(),
    itemId: "private-automation",
    toolName: "authorize_local_automation",
    argumentsJson: JSON.stringify({ tool, name: "click", arguments: '{"target":"@e1"}' }),
    expiresAt: timestampFromDate(new Date(Date.now() + ttl)),
  });
}

const pending = (threadId: string) =>
  gateway.runtime.runPromise(GatewayStore.use((store) => store.pendingInteractions(threadId)));

const pendingPrompt = (threadId: string) =>
  eventually(
    () => pending(threadId),
    (items) => items.length === 1,
  );

const connection = (workerId = gateway.workerId) => {
  const found = gateway.core.link.connections.get(workerId);

  if (!found) throw new Error("missing worker connection");

  return found;
};

async function outbox() {
  return query<{ kind: string }>(
    "SELECT kind FROM worker_commands WHERE kind IN ('run_agent_tool', 'install_agent_tool', 'probe_agent_tools', 'runAgentTool', 'installAgentTool', 'probeAgentTools')",
  );
}

describe.skipIf(!dockerAvailable)("automation owner grants and transient gateway commands", () => {
  beforeAll(async () => {
    gateway = await startTestGateway({ worker: { hello: { capabilities } } });
  }, 60_000);

  beforeEach(async () => {
    gateway.worker.handlers.clear();

    for (const tool of tools) await grant(false, tool);
    await publish();
    gateway.worker.commands.length = 0;
    gateway.worker.handlers.set("probeAgentTools", (_command, reply) => reply(true, { agentTools: report() }));
    gateway.worker.handlers.set("runAgentTool", (command, reply) => {
      if (!("operation" in command)) throw new Error("expected automation operation");
      reply(true, { agentTool: { operation: command.operation, text: "automation snapshot" } });
    });
  });

  afterAll(async () => {
    await gateway?.close();
  }, 30_000);

  test("enabling tools prepares installation and runtime without duplicating running or ready tools", async () => {
    await expectAgentToolEnablement(gateway);
    expect(await outbox()).toEqual([]);
  });

  test("installation and ready reports never grant tools; explicit grants reach turns and revocation is immediate", async () => {
    expect((await view())?.agentTools.map((item) => item.enabled)).toEqual([false, false, false]);
    expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toEqual([]);
    expect(await code(run())).toBe(Code.PermissionDenied);
    expect(automation(gateway.worker)).toEqual([]);

    const project = (await gateway.api.createProject({ name: "Automation grants" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project.id,
        workerId: gateway.workerId,
        rootPath: "/repo/automation",
      })
    ).workspace!;

    const thread = (
      await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    await gateway.worker.createdThread(thread.id);

    const creation = gateway.worker.commands.find(
      (command) => command.case === "createThread" && command.value.thread?.threadId === thread.id,
    );

    expect(creation?.case === "createThread" && creation.value.thread?.localMcpTools).toEqual([]);

    await publish(report({ installed: false, ready: false }));
    expect(
      (await gateway.api.installAgentTool({ workerId: gateway.workerId, tool: AgentTool.BROWSER })).started,
    ).toEqual([gateway.workerId]);
    await publish();
    expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toEqual([]);
    await grant(true);
    expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toEqual([AgentTool.BROWSER]);
    expect(await code(gateway.core.agentTools.authorize(gateway.workerId, AgentTool.BROWSER))).toBe(0);

    const turn = (
      await gateway.api.sendMessage({
        threadId: thread.id,
        text: "Inspect the page",
        clientRequestId: crypto.randomUUID(),
      })
    ).turn!;

    const start = await eventually(
      async () =>
        gateway.worker.commands.find((command) => command.case === "startTurn" && command.value.turnId === turn.id),
      Boolean,
    );

    expect(start?.case === "startTurn" && start.value.thread?.localMcpTools).toEqual([AgentTool.BROWSER]);
    await eventually(
      () => gateway.api.getThread({ threadId: thread.id }),
      (item) => item.thread?.status === "idle",
    );
    await grant(false);
    expect(await code(gateway.core.agentTools.authorize(gateway.workerId, AgentTool.BROWSER))).toBe(
      Code.PermissionDenied,
    );
    expect(await code(run())).toBe(Code.PermissionDenied);
    expect((await view())?.agentTools[0]?.enabled).toBe(false);
  });

  test("all actions refuse another owner's worker and global refresh probes only this owner's workers", async () => {
    const other = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("automation-other@localhost", "Other")),
    );

    const foreign = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.addWorker({ name: "Foreign automation", ownerUserId: other })),
    );

    await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.setWorkerConfig(foreign.workerId, { codex: { enabled: false } }, other)),
    );
    const worker = await gateway.connect(foreign.workerId, foreign.credential, undefined, { hello: { capabilities } });
    await eventually(
      async () =>
        query<{ applied: string | null }>(
          "SELECT applied_version::text AS applied FROM worker_configs WHERE worker_id = $1",
          [foreign.workerId],
        ),
      (rows) => rows[0]?.applied === "1",
    );
    const value = report();
    worker.link.send({ case: "agentToolsReport", value });
    worker.link.send({
      case: "configApplied",
      value: {
        version: 1n,
        applied: true,
        providers: [{ provider: Provider.CODEX, version: "automation-report-processed" }],
      },
    });

    const processed = await eventually(
      async () =>
        query<{ processed: boolean }>(
          "SELECT apply_report->'providers'->0->>'version' = 'automation-report-processed' AS processed FROM worker_configs WHERE worker_id = $1",
          [foreign.workerId],
        ),
      (rows) => rows[0]?.processed === true,
    );

    expect(processed[0]?.processed).toBe(true);
    expect(await view(foreign.workerId)).toBeUndefined();
    expect(await code(run("snapshot", foreign.workerId))).toBe(Code.NotFound);
    expect(await code(grant(true, AgentTool.BROWSER, foreign.workerId))).toBe(Code.NotFound);
    expect(await code(gateway.api.installAgentTool({ workerId: foreign.workerId, tool: AgentTool.BROWSER }))).toBe(
      Code.NotFound,
    );
    expect(await code(gateway.api.refreshAgentTools({ workerId: foreign.workerId }))).toBe(Code.NotFound);
    expect(await code(gateway.core.agentTools.authorize(foreign.workerId, AgentTool.BROWSER))).toBe(Code.NotFound);
    expect(await code(gateway.core.agentTools.authorizePreview(foreign.workerId, AgentTool.DEVICE))).toBe(
      Code.NotFound,
    );
    expect(await gateway.core.agentTools.readyTools(foreign.workerId)).toEqual([]);
    expect(
      await query<{ report: string | null }>(
        "SELECT capabilities->>'agentTools' AS report FROM workers WHERE id = $1",
        [foreign.workerId],
      ),
    ).toEqual([{ report: null }]);
    const before = automation(gateway.worker).length;
    await gateway.api.refreshAgentTools({});
    expect(automation(gateway.worker)).toHaveLength(before + 1);
    expect(automation(worker)).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  test("invalid ids, tool enums, operations, arguments and install options are rejected before dispatch", async () => {
    await grant(true);
    const before = automation(gateway.worker).length;

    for (const id of ["", "invalid", "' OR 1=1"]) {
      expect(await code(run("snapshot", id))).toBe(Code.InvalidArgument);
      expect(await code(grant(true, AgentTool.BROWSER, id))).toBe(Code.InvalidArgument);
      expect(await code(gateway.api.installAgentTool({ workerId: id, tool: AgentTool.BROWSER }))).toBe(
        Code.InvalidArgument,
      );

      if (id) expect(await code(gateway.api.refreshAgentTools({ workerId: id }))).toBe(Code.InvalidArgument);
    }

    expect(await code(run("snapshot", crypto.randomUUID()))).toBe(Code.NotFound);
    const qualified = `${gateway.workerId}~1234567890abcdef`;
    expect(await code(run("snapshot", qualified))).toBe(Code.NotFound);
    expect(await code(grant(true, AgentTool.BROWSER, qualified))).toBe(Code.NotFound);
    expect(await code(gateway.api.installAgentTool({ workerId: qualified, tool: AgentTool.BROWSER }))).toBe(
      Code.NotFound,
    );
    expect(await code(gateway.api.refreshAgentTools({ workerId: qualified }))).toBe(Code.NotFound);

    for (const tool of [AgentTool.UNSPECIFIED, 99]) {
      expect(await code(run("snapshot", gateway.workerId, tool))).toBe(Code.InvalidArgument);
      expect(await code(grant(true, tool))).toBe(Code.InvalidArgument);
      expect(await code(gateway.api.installAgentTool({ workerId: gateway.workerId, tool }))).toBe(Code.InvalidArgument);
    }

    expect(await code(gateway.api.runAgentTool({ workerId: gateway.workerId }))).toBe(Code.InvalidArgument);
    expect(await code(run("eval"))).toBe(Code.InvalidArgument);

    for (const field of ["target", "value", "platform", "session", "app", "windowId", "deviceId"]) {
      for (const value of ["x".repeat(16_385), "bad\0argument", "bad\u001bargument", "bad\u007fargument"]) {
        expect(
          await code(
            gateway.api.runAgentTool({
              workerId: gateway.workerId,
              operation: { tool: AgentTool.BROWSER, operation: "click", [field]: value },
            }),
          ),
        ).toBe(Code.InvalidArgument);
      }
    }

    expect(
      await code(
        gateway.api.runAgentTool({
          workerId: gateway.workerId,
          operation: { tool: AgentTool.DEVICE, operation: "snapshot", platform: "unexpected" },
        }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(
      await code(
        gateway.api.installAgentTool({
          workerId: gateway.workerId,
          tool: AgentTool.BROWSER,
          version: "1.2.3;touch /tmp/invalid",
        }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(
      await code(
        gateway.api.installAgentTool({ workerId: gateway.workerId, tool: AgentTool.DESKTOP, installRuntime: true }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(automation(gateway.worker)).toHaveLength(before);
  });

  test("validated session and device selectors are forwarded without losing the CLI target", async () => {
    for (const tool of tools) await grant(true, tool);

    const operations = [
      {
        tool: AgentTool.BROWSER,
        operation: "fill",
        target: "@e1",
        value: "line one\nline two\ttab",
        session: "canopy-session",
      },
      {
        tool: AgentTool.DESKTOP,
        operation: "open",
        target: "Text Editor",
        app: "Text Editor",
        session: "desktop-session",
      },
      {
        tool: AgentTool.DESKTOP,
        operation: "close",
        target: "Text Editor",
        app: "Text Editor",
        session: "desktop-session",
      },
      {
        tool: AgentTool.DESKTOP,
        operation: "snapshot",
        app: "Text Editor",
        windowId: "1234",
        session: "desktop-session",
      },
      {
        tool: AgentTool.DEVICE,
        operation: "open",
        app: "com.example.app",
        platform: "android",
        deviceId: "device-1234",
        session: "device-session",
      },
      {
        tool: AgentTool.DEVICE,
        operation: "snapshot",
        platform: "harmonyos",
        deviceId: "device-1234",
        session: "device-session",
      },
    ];

    for (const operation of operations) {
      await gateway.api.runAgentTool({ workerId: gateway.workerId, operation });
      const sent = automation(gateway.worker).at(-1);
      expect(sent?.case).toBe("runAgentTool");
      expect(sent?.case === "runAgentTool" && sent.value).toMatchObject(operation);
    }

    const before = automation(gateway.worker).length;

    for (const field of ["session", "app", "windowId", "deviceId"]) {
      for (const value of ["line\nselector", "tab\tselector", "bad\u0085selector"]) {
        expect(
          await code(
            gateway.api.runAgentTool({
              workerId: gateway.workerId,
              operation: { tool: AgentTool.BROWSER, operation: "snapshot", [field]: value },
            }),
          ),
        ).toBe(Code.InvalidArgument);
      }
    }

    for (const operation of [
      { tool: AgentTool.BROWSER, operation: "snapshot", app: "Text Editor" },
      { tool: AgentTool.DEVICE, operation: "snapshot", windowId: "1234" },
      { tool: AgentTool.DESKTOP, operation: "snapshot", deviceId: "device-1234" },
      { tool: AgentTool.DESKTOP, operation: "open", app: "Text Editor", windowId: "1234" },
      { tool: AgentTool.DESKTOP, operation: "click", target: "@s123:e1", app: "Text Editor" },
      { tool: AgentTool.DEVICE, operation: "snapshot", app: "com.example.app" },
      { tool: AgentTool.DEVICE, operation: "snapshot", platform: "web", deviceId: "device-1234" },
      { tool: AgentTool.DEVICE, operation: "snapshot", deviceId: "device-1234" },
    ])
      expect(await code(gateway.api.runAgentTool({ workerId: gateway.workerId, operation }))).toBe(
        Code.InvalidArgument,
      );
    expect(automation(gateway.worker)).toHaveLength(before);
  });

  test.each([AgentTool.BROWSER, AgentTool.DESKTOP])(
    "tool %s requires readiness and screenshot capability",
    async (tool) => {
      await grant(true, tool);
      await publish(report({ ready: false }));
      expect((await view())?.agentTools.map((item) => item.action)).toEqual(["install", "install", "install"]);
      expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toEqual([]);
      expect(await code(run("snapshot", gateway.workerId, tool))).toBe(Code.FailedPrecondition);
      expect(await code(gateway.core.agentTools.authorize(gateway.workerId, tool))).toBe(Code.FailedPrecondition);
      await publish(report({ installed: false }));
      expect(await code(run("snapshot", gateway.workerId, tool))).toBe(Code.FailedPrecondition);
      await publish(report({ screenshot: false }));
      expect(await code(run("screenshot", gateway.workerId, tool))).toBe(Code.FailedPrecondition);
      expect(automation(gateway.worker)).toEqual([]);
      expect((await run("snapshot", gateway.workerId, tool)).result?.text).toBe("automation snapshot");
    },
  );

  test("malformed reports cannot replace the last valid facts and install progress is bounded and transient", async () => {
    const current = await publish(report({ install: { installId: "current-install", state: "running" } }));
    await grant(true);
    gateway.worker.link.send({ case: "agentToolsReport", value: report({ tool: unknownTool }) });
    gateway.worker.link.send({ case: "agentToolsReport", value: report({ detail: "x".repeat(70_000) }) });
    gateway.worker.link.send({ case: "agentToolsReport", value: { tools: [current.tools[0]!, current.tools[0]!] } });
    gateway.worker.link.send({
      case: "agentToolProgress",
      value: { tool: AgentTool.BROWSER, installId: "stale-install", lines: ["must be ignored"] },
    });
    gateway.worker.link.send({
      case: "agentToolProgress",
      value: { tool: unknownTool, installId: "current-install", lines: ["unknown tool"] },
    });
    const lines = Array.from({ length: 300 }, (_, index) => `${index}: ${"x".repeat(2000)}`);
    gateway.worker.link.send({
      case: "agentToolProgress",
      value: { tool: AgentTool.BROWSER, installId: "current-install", lines },
    });
    const worker = await eventually(view, (item) => item?.agentTools[0]?.log.length === 200);
    const browser = worker?.agentTools[0];
    expect(browser?.log).toHaveLength(200);
    expect(browser?.log[0]?.startsWith("100:")).toBe(true);
    expect(browser?.log.at(-1)?.startsWith("299:")).toBe(true);
    expect(browser?.log.every((line) => line.length <= 1024)).toBe(true);
    expect(browser?.enabled).toBe(true);
    expect(browser?.tool?.version).toBe(current.tools[0]?.version);
    expect(browser?.log.join()).not.toContain("must be ignored");

    const stored = await query<{ report: string }>(
      "SELECT capabilities->>'agentTools' AS report FROM workers WHERE id = $1",
      [gateway.workerId],
    );

    expect(stored[0]?.report).not.toContain("100:");
    expect(await outbox()).toEqual([]);
  });

  test("old and offline workers receive no automation commands; their preferences can still be revoked", async () => {
    const old = await readyWorker("Old automation worker", false);
    old.worker.link.send({ case: "agentToolsReport", value: report() });
    expect(await code(grant(true, AgentTool.BROWSER, old.workerId))).toBe(Code.FailedPrecondition);
    expect(await code(run("snapshot", old.workerId))).toBe(Code.FailedPrecondition);
    expect(await code(gateway.api.installAgentTool({ workerId: old.workerId, tool: AgentTool.BROWSER }))).toBe(
      Code.FailedPrecondition,
    );
    expect((await gateway.api.refreshAgentTools({ workerId: old.workerId })).skipped.join()).toContain(
      "update this worker",
    );
    expect(automation(old.worker)).toEqual([]);
    expect(await gateway.core.agentTools.readyTools(old.workerId)).toEqual([]);
    const capable = await readyWorker("Offline automation worker");
    await publish(report(), capable.worker, capable.workerId);
    await grant(true, AgentTool.BROWSER, capable.workerId);
    capable.worker.link.close();
    await capable.worker.link.closed;
    await eventually(
      async () => gateway.core.link.connections.has(capable.workerId),
      (connected) => !connected,
    );
    expect(await gateway.core.agentTools.readyTools(capable.workerId)).toEqual([]);
    expect(await code(run("snapshot", capable.workerId))).toBe(Code.Unavailable);
    expect(await code(gateway.api.installAgentTool({ workerId: capable.workerId, tool: AgentTool.BROWSER }))).toBe(
      Code.Unavailable,
    );
    expect((await gateway.api.refreshAgentTools({ workerId: capable.workerId })).skipped.join()).toContain("offline");
    expect(await code(grant(true, AgentTool.BROWSER, capable.workerId))).toBe(Code.Unavailable);
    expect(await code(grant(false, AgentTool.BROWSER, capable.workerId))).toBe(0);
    expect((await view(capable.workerId))?.agentTools[0]?.enabled).toBe(false);
    expect(await outbox()).toEqual([]);
  });

  test("screenshot bytes return only to the caller; invalid worker output cannot cross the boundary", async () => {
    await grant(true);

    const before = await query<{ commands: number; attachments: number; events: number }>(
      "SELECT (SELECT count(*)::int FROM worker_commands) AS commands, (SELECT count(*)::int FROM attachments) AS attachments, (SELECT count(*)::int FROM thread_events) AS events",
    );

    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    gateway.worker.handlers.set("runAgentTool", (_command, reply) =>
      reply(true, {
        agentTool: { operation: "screenshot", text: "private screenshot", mimeType: "image/png", data: png },
      }),
    );
    const response = await run("screenshot");
    expect(response.result?.data).toEqual(png);
    expect(response.result?.mimeType).toBe("image/png");
    const overview = toJsonString(ui.GetOverviewResponseSchema, await gateway.api.getOverview({}));
    expect(overview).not.toContain("private screenshot");
    expect(overview).not.toContain(Buffer.from(png).toString("base64"));
    expect(
      await query<{ commands: number; attachments: number; events: number }>(
        "SELECT (SELECT count(*)::int FROM worker_commands) AS commands, (SELECT count(*)::int FROM attachments) AS attachments, (SELECT count(*)::int FROM thread_events) AS events",
      ),
    ).toEqual(before);
    gateway.worker.handlers.set("runAgentTool", (_command, reply) =>
      reply(true, { agentTool: { operation: "snapshot", text: "x".repeat(512 * 1024 + 1) } }),
    );
    expect(await code(run())).toBe(Code.ResourceExhausted);
    gateway.worker.handlers.set("runAgentTool", (_command, reply) =>
      reply(true, {
        agentTool: { operation: "screenshot", mimeType: "image/png", data: new Uint8Array(4 * 1024 * 1024 + 1) },
      }),
    );
    expect(await code(run("screenshot"))).toBe(Code.ResourceExhausted);
    gateway.worker.handlers.set("runAgentTool", (_command, reply) =>
      reply(true, { agentTool: { operation: "snapshot", mimeType: "image/png", data: png } }),
    );
    expect(await code(run())).toBe(Code.FailedPrecondition);
    expect(await outbox()).toEqual([]);
  });

  test("a disconnected operation is never stored or replayed on worker reconnect", async () => {
    const registered = await readyWorker("Disconnect automation worker");
    await publish(report(), registered.worker, registered.workerId);
    await grant(true, AgentTool.BROWSER, registered.workerId);
    registered.worker.handlers.set("runAgentTool", () => registered.worker.link.close());
    expect(await code(run("click", registered.workerId))).toBe(Code.Unavailable);
    expect(automation(registered.worker).map((command) => command.case)).toEqual(["runAgentTool"]);
    expect(await outbox()).toEqual([]);

    const reconnected = await gateway.connect(registered.workerId, registered.credential, undefined, {
      hello: { capabilities },
    });

    const current = await eventually(
      () => view(registered.workerId),
      (worker) => worker?.online === true,
    );

    expect(current?.online).toBe(true);
    expect(await gateway.core.agentTools.readyTools(registered.workerId)).toEqual([AgentTool.BROWSER]);
    expect(automation(reconnected)).toEqual([]);
  });

  test.each([AgentTool.BROWSER, AgentTool.DEVICE])(
    "MCP tool %s rechecks grants, turns, ownership and permissions",
    async (tool) => {
      await publish(report({ ready: tool !== AgentTool.DEVICE }));
      await grant(true, tool);
      const target = await heldThread(PermissionMode.FULL_AUTO);

      const authorize = (worker = gateway.worker, turnId = target.turnId, expiresAt = new Date(Date.now() + 60_000)) =>
        worker.callTool({
          ...target,
          turnId,
          tool: "authorize_local_automation",
          args: { tool, name: "devices", arguments: "{}" },
          expiresAt,
        });

      try {
        const start = gateway.worker.commands.find(
          (command) => command.case === "startTurn" && command.value.turnId === target.turnId,
        );

        expect(start?.case === "startTurn" && start.value.thread?.localMcpTools).toEqual([tool]);
        expect((await authorize()).isError).toBe(false);

        if (tool === AgentTool.DEVICE) {
          expect(await code(run("snapshot", gateway.workerId, tool))).toBe(Code.FailedPrecondition);

          for (const invalid of [{ installed: false }, { version: "0.21.36" }, { install: { state: "running" } }]) {
            await publish(report({ ...invalid }));
            expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toEqual([]);
            expect((await authorize()).isError).toBe(true);
          }

          await publish(report({ ready: false }));
        }

        await grant(false, tool);
        expect((await authorize()).isError).toBe(true);
        await grant(true, tool);
        expect((await authorize()).isError).toBe(false);
        expect((await authorize(gateway.worker, crypto.randomUUID())).isError).toBe(true);
        expect((await authorize(gateway.worker, target.turnId, new Date(Date.now() - 1000))).isError).toBe(true);
        const other = await readyWorker("Wrong automation caller");
        await publish(report(), other.worker, other.workerId);
        await grant(true, tool, other.workerId);
        expect((await authorize(other.worker)).isError).toBe(true);

        await query("UPDATE threads SET archived_at = now() WHERE id = $1", [target.threadId]);
        expect((await authorize()).isError).toBe(true);
        await query("UPDATE threads SET archived_at = NULL WHERE id = $1", [target.threadId]);
        gateway.worker.finish(target.threadId, target.turnId);
        await eventually(
          () => gateway.api.getThread({ threadId: target.threadId }),
          (item) => item.thread?.status === "idle",
        );
        expect((await authorize()).isError).toBe(true);

        const readOnly = (
          await gateway.api.sendMessage({
            threadId: target.threadId,
            text: "Read only",
            permissionMode: PermissionMode.READ_ONLY,
            clientRequestId: crypto.randomUUID(),
          })
        ).turn!;

        await eventually(async () => gateway.worker.started.has(readOnly.id), Boolean);
        expect((await authorize(gateway.worker, readOnly.id)).isError).toBe(true);
        gateway.worker.finish(target.threadId, readOnly.id);
      } finally {
        gateway.worker.holdTurns = false;
      }
    },
  );

  test.each([AgentTool.BROWSER, AgentTool.DEVICE])(
    "MCP tool %s cannot duplicate or reuse an approval",
    async (tool) => {
      await publish(report({ ready: tool !== AgentTool.DEVICE }));
      await grant(true, tool);
      const target = await heldThread();
      const source = connection();
      const call = authorization(target, 5000, tool);
      const original = authorizeLocalAutomation(gateway.core, call, source);

      const prompts = await pendingPrompt(target.threadId);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.requestId).not.toBe(call.callId);
      expect(prompts[0]?.expiresAt).toEqual(call.expiresAt);
      expect((await authorizeLocalAutomation(gateway.core, call, source)).isError).toBe(true);
      expect(
        (
          await authorizeLocalAutomation(
            gateway.core,
            create(AgentToolCallSchema, {
              ...call,
              argumentsJson: JSON.stringify({ tool, name: "click", arguments: '{"target":"@e2"}' }),
            }),
            source,
          )
        ).isError,
      ).toBe(true);
      expect(await pending(target.threadId)).toHaveLength(1);
      await gateway.api.answerInteraction({ requestId: prompts[0]!.requestId, allow: true });
      expect((await original).isError).toBe(false);
      expect((await authorizeLocalAutomation(gateway.core, call, source)).isError).toBe(true);
      const stale = authorization(target, 5000, tool);
      await gateway.runtime.runPromise(
        GatewayStore.use((store) =>
          store.recordInteraction(
            create(InteractionRequestSchema, {
              requestId: stale.callId,
              ...target,
              kind: InteractionKind.PERMISSION,
              toolName: "previous approval",
              requestJson: "{}",
            }),
          ),
        ),
      );
      await gateway.api.answerInteraction({ requestId: stale.callId, allow: true });
      const fresh = authorizeLocalAutomation(gateway.core, stale, source);

      const asked = await pendingPrompt(target.threadId);

      expect(asked[0]?.requestId).not.toBe(stale.callId);
      await gateway.api.answerInteraction({ requestId: asked[0]!.requestId, allow: false });
      expect((await fresh).isError).toBe(true);
      gateway.worker.finish(target.threadId, target.turnId);
      gateway.worker.holdTurns = false;
    },
  );

  test.each([AgentTool.BROWSER, AgentTool.DEVICE])(
    "MCP tool %s expires prompts on cancellation, expiry and revocation",
    async (tool) => {
      await publish(report({ ready: tool !== AgentTool.DEVICE }));
      await grant(true, tool);
      const target = await heldThread();
      const source = connection();

      for (const reason of ["cancel", "expire", "revoke"]) {
        const call = authorization(target, reason === "expire" ? 400 : 5000, tool);
        const original = authorizeLocalAutomation(gateway.core, call, source);

        const prompts = await pendingPrompt(target.threadId);

        expect(prompts).toHaveLength(1);

        if (reason === "cancel")
          expect(
            (
              await authorizeLocalAutomation(
                gateway.core,
                create(AgentToolCallSchema, { ...call, cancelled: true }),
                source,
              )
            ).isError,
          ).toBe(true);

        if (reason === "revoke") await grant(false, tool);
        expect((await original).isError).toBe(true);
        expect(await pending(target.threadId)).toEqual([]);
        expect(await code(gateway.api.answerInteraction({ requestId: prompts[0]!.requestId, allow: true }))).toBe(
          Code.FailedPrecondition,
        );
        await grant(true, tool);
      }

      gateway.worker.finish(target.threadId, target.turnId);
      gateway.worker.holdTurns = false;
    },
  );

  test("worker replacement expires old approvals and fences buffered requests from the previous connection", async () => {
    const registered = await readyWorker("Automation source fence");
    await publish(report(), registered.worker, registered.workerId);
    await grant(true, AgentTool.BROWSER, registered.workerId);
    const target = await heldThread(PermissionMode.ASK, registered.worker, registered.workerId);
    const previous = connection(registered.workerId);
    const call = authorization(target);
    const original = authorizeLocalAutomation(gateway.core, call, previous);

    const prompts = await pendingPrompt(target.threadId);

    expect(prompts).toHaveLength(1);

    const replacement = await gateway.connect(registered.workerId, registered.credential, undefined, {
      hello: { capabilities },
    });

    expect((await original).isError).toBe(true);
    expect(await pending(target.threadId)).toEqual([]);
    const live = await heldThread(PermissionMode.FULL_AUTO, replacement, registered.workerId);
    const request = authorization(live);
    expect((await authorizeLocalAutomation(gateway.core, request, previous)).isError).toBe(true);
    expect((await authorizeLocalAutomation(gateway.core, request, connection(registered.workerId))).isError).toBe(
      false,
    );
    replacement.finish(live.threadId, live.turnId);
    replacement.holdTurns = false;
  });

  test("authorization state stays bounded per connection, preserves consumed IDs and releases expired entries", async () => {
    const registered = await readyWorker("Bounded automation authorizations");
    await publish(report(), registered.worker, registered.workerId);
    await grant(true, AgentTool.BROWSER, registered.workerId);
    const target = await heldThread(PermissionMode.FULL_AUTO, registered.worker, registered.workerId);
    const source = connection(registered.workerId);

    const requests = Array.from({ length: 1024 }, () =>
      create(AgentToolCallSchema, { ...authorization(target, 1500), argumentsJson: "invalid" }),
    );

    for (const request of requests)
      await authorizeLocalAutomation(
        gateway.core,
        create(AgentToolCallSchema, { ...request, cancelled: true }),
        source,
      );
    const valid = authorization(target);
    expect((await authorizeLocalAutomation(gateway.core, valid, source)).isError).toBe(false);

    for (const request of requests) await authorizeLocalAutomation(gateway.core, request, source);
    expect((await authorizeLocalAutomation(gateway.core, authorization(target), source)).isError).toBe(true);
    expect((await authorizeLocalAutomation(gateway.core, valid, source)).isError).toBe(true);
    const start = Date.now();

    const afterExpiry = await eventually(
      async () => authorizeLocalAutomation(gateway.core, authorization(target), source),
      (result) => !result.isError,
      3000,
    );

    expect(afterExpiry.isError).toBe(false);
    expect((await authorizeLocalAutomation(gateway.core, valid, source)).isError).toBe(true);
    expect(Date.now() - start).toBeGreaterThan(500);
    registered.worker.finish(target.threadId, target.turnId);
    registered.worker.holdTurns = false;
  }, 10_000);

  test(
    "linked requests route session IDs, preserve OS selectors and enforce home grants",
    expectLinkedAgentToolRouting,
    90_000,
  );

  test("owner grants survive gateway restart and worker reports; completed actions are never replayed", async () => {
    await grant(true);
    await gateway.api.refreshAgentTools({ workerId: gateway.workerId });
    await run();
    expect((await view())?.agentTools[0]?.enabled).toBe(true);

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage, worker: { hello: { capabilities } } });
    expect((await view())?.agentTools[0]?.enabled).toBe(true);
    expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toEqual([AgentTool.BROWSER]);
    expect(automation(gateway.worker)).toEqual([]);
    expect(await outbox()).toEqual([]);
  }, 30_000);
});
