import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { AgentTool, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { type JsonObject } from "@canopy/domain";
import { qualifyId } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { LOCAL_AUTOMATION_COMPLETION_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { expireLocalAutomationLeases } from "../../apps/gateway/src/core/automation-permissions.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { configComputer, pairConfig } from "./support/config-sync.ts";

const tools = [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE];
const completionHello = { capabilities: ["agent_tools_v1", LOCAL_AUTOMATION_COMPLETION_CAPABILITY] };

async function completionWorker(gateway: TestGateway, name: string) {
  const registration = await gateway.addWorker(name);

  const worker = await gateway.connect(registration.workerId, registration.credential, undefined, {
    hello: completionHello,
  });

  return { ...gateway, ...registration, worker };
}

async function running(gateway: TestGateway, mode = PermissionMode.FULL_AUTO) {
  gateway.worker.holdTurns = true;
  gateway.worker.link.send({
    case: "agentToolsReport",
    value: {
      tools: tools.map((tool) => ({
        tool,
        installed: true,
        ready: true,
        version: tool === AgentTool.DEVICE ? "0.21.37" : tool === AgentTool.DESKTOP ? "1.3.1" : "0.43.0",
      })),
    },
  });
  expect(
    await eventually(
      async () => (await gateway.api.getOverview({})).workers.find((worker) => worker.id === gateway.workerId),
      (worker) => worker?.agentTools.length === 3,
    ),
  ).toBeDefined();

  for (const tool of tools) await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool, enabled: true });
  const project = (await gateway.api.createProject({ name: "Live automation activity" })).project!;

  const workspace = (
    await gateway.api.createWorkspace({ projectId: project.id, workerId: gateway.workerId, rootPath: "/repo/activity" })
  ).workspace!;

  const thread = (
    await gateway.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      permissionMode: mode,
    })
  ).thread!;

  await gateway.worker.createdThread(thread.id);

  const turn = (
    await gateway.api.sendMessage({ threadId: thread.id, text: "Inspect", clientRequestId: crypto.randomUUID() })
  ).turn!;

  expect(await eventually(async () => gateway.worker.started.has(turn.id), Boolean)).toBe(true);
  expect(
    await eventually(
      () => gateway.runtime.runPromise(GatewayStore.use((store) => store.runningTurn(thread.id))),
      (current) => current?.id === turn.id,
    ),
  ).toBeDefined();

  return { threadId: thread.id, turnId: turn.id };
}

function authorize(
  gateway: TestGateway,
  scope: { threadId: string; turnId: string },
  tool: AgentTool,
  name: string,
  input: JsonObject = {},
  callId = crypto.randomUUID(),
) {
  return gateway.worker.callTool({
    ...scope,
    callId,
    tool: "authorize_local_automation",
    args: { tool, name, arguments: JSON.stringify(input) },
    expiresAt: new Date(Date.now() + 10_000),
  });
}

async function watch(api: TestGateway["api"], threadId: string, checkpoint?: ui.ThreadSnapshot) {
  const abort = new AbortController();
  const activities: ui.ThreadAutomationActivity[] = [];
  const finished: ui.ThreadAutomationActivity[] = [];
  const resets: string[] = [];
  let snapshot = checkpoint;
  let ready = false;
  let failure: unknown;

  const reading = (async () => {
    try {
      for await (const update of api.watchThread(
        { threadId, sequence: true, syncCursor: checkpoint?.syncCursor },
        { signal: abort.signal, timeoutMs: 0 },
      )) {
        snapshot = applyThreadUpdate(snapshot, update);

        if (update.change.case === "automationActivity") activities.push(update.change.value);

        if (update.change.case === "automationActivityFinished") finished.push(update.change.value);

        if (update.change.case === "automationActivityReset") resets.push(update.change.value);

        if (update.change.case === "batch" && update.change.value.caughtUp) ready = true;
      }
    } catch (cause) {
      if (!abort.signal.aborted) failure = cause;
    }
  })();

  try {
    expect(await eventually(async () => ready || failure !== undefined, Boolean)).toBe(true);
    expect(failure).toBeUndefined();
  } catch (cause) {
    abort.abort();
    await reading;
    throw cause;
  }

  return {
    activities,
    finished,
    resets,
    get snapshot() {
      return snapshot!;
    },
    async until(count: number, completions = 0, lost = 0) {
      expect(
        await eventually(
          async () => [activities.length, finished.length, resets.length],
          ([starts, ends, abandoned]) => starts === count && ends === completions && abandoned === lost,
        ),
      ).toEqual([count, completions, lost]);
      expect(failure).toBeUndefined();
    },
    async close() {
      abort.abort();
      await reading;
    },
  };
}

describe.skipIf(!dockerAvailable)("ephemeral approved automation activity over WorkerLink and UI gRPC", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 50, worker: { hello: { capabilities: ["agent_tools_v1"] } } });
  }, 60_000);
  afterAll(async () => gateway?.close());

  test("approved calls expose only proven selectors, once, without changing the durable snapshot", async () => {
    const scope = await running(gateway);
    const live = await watch(gateway.api, scope.threadId);
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const checkpoint = toJsonString(ui.ThreadSnapshotSchema, live.snapshot);
    const deviceId = crypto.randomUUID();
    const windowId = crypto.randomUUID();
    const callId = crypto.randomUUID();

    try {
      expect(
        (
          await authorize(
            gateway,
            scope,
            AgentTool.BROWSER,
            "browser_open",
            {
              url: "https://private.invalid/token",
              text: "private-input",
              token: "private-secret",
              session: scope.threadId,
            },
            callId,
          )
        ).isError,
      ).toBe(false);
      await live.until(1);
      expect(live.activities[0]).toMatchObject({
        id: callId,
        turnId: scope.turnId,
        workerId: gateway.workerId,
        tool: AgentTool.BROWSER,
        platform: "",
        deviceId: "",
        windowId: "",
        app: "",
        target: "",
        reportsCompletion: false,
      });
      gateway.worker.link.send({ case: "localAutomationFinished", value: { callId } });
      expect((await authorize(gateway, scope, AgentTool.BROWSER, "browser_open", {}, callId)).isError).toBe(true);
      expect(
        (
          await authorize(gateway, scope, AgentTool.DESKTOP, "desktop_snapshot", {
            app: "Background App",
            window_id: windowId,
          })
        ).isError,
      ).toBe(false);
      await live.until(2);
      expect(live.activities[1]).toMatchObject({ tool: AgentTool.DESKTOP, app: "Background App", windowId });
      expect(
        (
          await authorize(gateway, scope, AgentTool.DEVICE, "snapshot", {
            platform: "ios",
            udid: deviceId,
            session: scope.threadId,
          })
        ).isError,
      ).toBe(false);
      await live.until(3);
      expect(live.activities[2]).toMatchObject({ tool: AgentTool.DEVICE, platform: "ios", deviceId });
      expect(
        (
          await authorize(gateway, scope, AgentTool.DESKTOP, "desktop_click", {
            ref_id: "@old:e1",
            window_id: windowId,
          })
        ).isError,
      ).toBe(false);
      await live.until(4);
      expect(live.activities[3]).toMatchObject({ app: "", windowId: "" });
      expect(toJsonString(ui.ThreadSnapshotSchema, live.snapshot)).toBe(checkpoint);
      expect(JSON.stringify(live.activities)).not.toContain("private-");

      const durable = await store.query<{ events: number; calls: number }>(
        `SELECT (SELECT count(*)::int FROM thread_events WHERE thread_id=$1::uuid AND raw::text LIKE '%authorize_local_automation%') AS events,
        (SELECT count(*)::int FROM agent_bus_calls WHERE source_thread_id=$1::uuid) AS calls`,
        [scope.threadId],
      );

      expect(durable[0]).toEqual({ events: 0, calls: 0 });
      await live.close();
      const reopened = await watch(gateway.api, scope.threadId);

      try {
        expect(reopened.activities).toEqual([]);
        expect((await authorize(gateway, scope, AgentTool.BROWSER, "browser_snapshot")).isError).toBe(false);
        await reopened.until(1);
        expect(reopened.activities[0]?.id).not.toBe(callId);
      } finally {
        await reopened.close();
      }
    } finally {
      await live.close();
      gateway.worker.finish(scope.threadId, scope.turnId);
    }
  });

  test("overlapping calls finish once on the admitting connection and never on its replacement", async () => {
    const scoped = await completionWorker(gateway, "Completion worker");
    const { worker, workerId, credential } = scoped;
    const scope = await running(scoped);
    let live = await watch(gateway.api, scope.threadId);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];

    try {
      const admitted = await Promise.all(
        ids.map((id) => authorize(scoped, scope, AgentTool.DESKTOP, "desktop_click", {}, id)),
      );

      expect(admitted.every((result) => !result.isError)).toBe(true);
      gateway.worker.link.send({ case: "localAutomationFinished", value: { callId: ids[0]! } });
      // Wait until the gateway has consumed the foreign notice on its own stream.
      expect((await authorize(gateway, scope, AgentTool.DESKTOP, "desktop_click")).isError).toBe(true);
      worker.link.send({ case: "localAutomationFinished", value: { callId: ids[1]! } });
      worker.link.send({ case: "localAutomationFinished", value: { callId: ids[1]! } });
      worker.link.send({ case: "localAutomationFinished", value: { callId: crypto.randomUUID() } });
      await live.until(2, 1);
      expect(live.finished[0]).toEqual(live.activities.find((activity) => activity.id === ids[1]));
      expect(live.finished[0]?.reportsCompletion).toBe(true);

      // A worker can cancel after admission but before receiving the grant and starting the MCP call.
      const interrupted = {
        ...scope,
        callId: crypto.randomUUID(),
        tool: "authorize_local_automation",
        args: { tool: AgentTool.DESKTOP, name: "desktop_click", arguments: "{}" },
        expiresAt: new Date(Date.now() + 10_000),
      };

      expect((await worker.callTool(interrupted)).isError).toBe(false);
      expect((await worker.callTool({ ...interrupted, cancelled: true })).isError).toBe(true);
      worker.link.send({ case: "localAutomationFinished", value: { callId: interrupted.callId } });
      await live.until(3, 2);

      const replacement = await gateway.connect(workerId, credential, undefined, {
        hello: completionHello,
        resumeJournal: true,
      });

      await live.until(3, 2, 1);
      expect(live.resets).toEqual([ids[0]!]);
      expect(live.finished.map((activity) => activity.id)).toEqual([ids[1]!, interrupted.callId]);
      replacement.link.send({ case: "localAutomationFinished", value: { callId: ids[0]! } });
      const next = crypto.randomUUID();
      expect(
        (await authorize({ ...scoped, worker: replacement }, scope, AgentTool.DESKTOP, "desktop_click", {}, next))
          .isError,
      ).toBe(false);
      replacement.link.send({ case: "localAutomationFinished", value: { callId: next } });
      await live.until(4, 3, 1);
      expect(live.finished.at(-1)?.id).toBe(next);
      await live.close();
      live = await watch(gateway.api, scope.threadId, live.snapshot);
      await live.until(0);
      replacement.finish(scope.threadId, scope.turnId);
    } finally {
      await live.close();
    }
  });

  test("a full live metadata queue resets preview tracking while the same transcript watch stays open", async () => {
    const scoped = await completionWorker(gateway, "Overflow worker");
    const { worker } = scoped;
    const scope = await running(scoped);
    const live = await watch(gateway.api, scope.threadId);
    const lost = crypto.randomUUID();

    // Deliver a burst in the same turn as a real completion, before the sequence reader can drain.
    const unsubscribe = gateway.core.hub.observeThread(scope.threadId, ({ change }) => {
      if (change.case !== "automationActivityFinished" || change.value.id !== lost) return;

      for (let index = 0; index < 128; index++)
        gateway.core.hub.publishThread(
          scope.threadId,
          create(ui.ThreadUpdateSchema, { change: { case: "schedule", value: { id: crypto.randomUUID() } } }),
        );
    });

    try {
      expect((await authorize(scoped, scope, AgentTool.DESKTOP, "desktop_click", {}, lost)).isError).toBe(false);
      await live.until(1);
      worker.link.send({ case: "localAutomationFinished", value: { callId: lost } });
      await live.until(1, 0, 1);
      expect(live.resets).toEqual([""]);
      const next = crypto.randomUUID();
      expect((await authorize(scoped, scope, AgentTool.DESKTOP, "desktop_click", {}, next)).isError).toBe(false);
      worker.link.send({ case: "localAutomationFinished", value: { callId: next } });
      await live.until(2, 1, 1);
      expect(live.finished[0]?.id).toBe(next);
    } finally {
      unsubscribe();
      await live.close();
      worker.finish(scope.threadId, scope.turnId);
    }
  });

  test("the heartbeat sweep retains admitted calls past approval expiry and discards abandoned calls", async () => {
    const scoped = await completionWorker(gateway, "Lease worker");
    const { worker } = scoped;
    const scope = await running(scoped);
    const live = await watch(gateway.api, scope.threadId);
    const connection = gateway.core.link.connections.get(scoped.workerId)!;
    const first = crypto.randomUUID();
    const lost = crypto.randomUUID();

    try {
      expect((await authorize(scoped, scope, AgentTool.DESKTOP, "desktop_click", {}, first)).isError).toBe(false);
      // The authorization in this suite has a ten-second deadline. The admitted MCP call can still return.
      expireLocalAutomationLeases(gateway.core, connection, Date.now() + 11_000);
      worker.link.send({ case: "localAutomationFinished", value: { callId: first } });
      await live.until(1, 1);
      expect((await authorize(scoped, scope, AgentTool.DESKTOP, "desktop_click", {}, lost)).isError).toBe(false);
      expireLocalAutomationLeases(gateway.core, connection, Date.now() + 311_000);
      await live.until(2, 1, 1);
      expect(live.resets).toEqual([lost]);
      worker.link.send({ case: "localAutomationFinished", value: { callId: lost } });
      const next = crypto.randomUUID();
      expect((await authorize(scoped, scope, AgentTool.DESKTOP, "desktop_click", {}, next)).isError).toBe(false);
      worker.link.send({ case: "localAutomationFinished", value: { callId: next } });
      await live.until(3, 2, 1);
      expect(live.finished.map((activity) => activity.id)).toEqual([first, next]);
    } finally {
      await live.close();
      worker.finish(scope.threadId, scope.turnId);
    }
  });

  test("pending, denied, revoked and foreign-session calls never signal; approval does", async () => {
    const scope = await running(gateway, PermissionMode.ASK);
    const live = await watch(gateway.api, scope.threadId);

    const pending = () =>
      gateway.runtime.runPromise(GatewayStore.use((store) => store.pendingInteractions(scope.threadId)));

    try {
      for (const allow of [false, true]) {
        const result = authorize(gateway, scope, AgentTool.BROWSER, "browser_snapshot");
        const prompts = await eventually(pending, (items) => items.length === 1);
        expect(prompts).toHaveLength(1);
        expect(live.activities).toEqual([]);
        await gateway.api.answerInteraction({ requestId: prompts[0]!.requestId, allow });
        expect((await result).isError).toBe(!allow);
      }

      await live.until(1);
      await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER });
      expect((await authorize(gateway, scope, AgentTool.BROWSER, "browser_snapshot")).isError).toBe(true);
      expect(live.activities).toHaveLength(1);
    } finally {
      await live.close();
      gateway.worker.finish(scope.threadId, scope.turnId);
    }

    const auto = await running(gateway);
    const current = await watch(gateway.api, auto.threadId);

    try {
      for (const input of [
        { session: "other-thread" },
        { extraArgs: ["--session=other-thread"] },
        { extraArgs: ["--headed"] },
        { extraArgs: ["--headed", "true"] },
        { extraArgs: ["--headed", "false", "--session", "other-thread"] },
        { session: { nested: "unproven" } },
      ])
        expect((await authorize(gateway, auto, AgentTool.BROWSER, "browser_snapshot", input)).isError).toBe(false);
      expect(
        (
          await authorize(gateway, auto, AgentTool.DEVICE, "snapshot", {
            platform: "ios",
            udid: "https://invalid/path",
          })
        ).isError,
      ).toBe(false);
      await current.until(1);
      expect(current.activities[0]).toMatchObject({ tool: AgentTool.DEVICE, platform: "", deviceId: "" });
      expect(
        (
          await authorize(gateway, auto, AgentTool.BROWSER, "browser_snapshot", {
            session: auto.threadId,
            extraArgs: ["--headed", "false"],
          })
        ).isError,
      ).toBe(false);
      await current.until(2);
    } finally {
      await current.close();
      gateway.worker.finish(auto.threadId, auto.turnId);
    }
  });
});

test.skipIf(!dockerAvailable)(
  "linked live activity qualifies Canopy scope and preserves opaque targets without mirror replay",
  async () => {
    const viewer = await configComputer("Automation activity viewer");
    const home = await configComputer("Automation activity home");
    let live: Awaited<ReturnType<typeof watch>> | undefined;

    try {
      await pairConfig(viewer, home);
      const gateway = await completionWorker(home.gateway, "Live automation");
      const { worker, workerId, credential } = gateway;
      const scope = await running(gateway);
      const threadId = qualifyId(scope.threadId, home.node);
      live = await watch(viewer.gateway.api, threadId);
      const windowId = crypto.randomUUID();
      const callId = crypto.randomUUID();
      expect(
        (
          await authorize(
            gateway,
            scope,
            AgentTool.DESKTOP,
            "desktop_snapshot",
            { app: "Background App", window_id: windowId },
            callId,
          )
        ).isError,
      ).toBe(false);
      worker.link.send({ case: "localAutomationFinished", value: { callId } });
      await live.until(1, 1);
      expect(live.finished).toEqual(live.activities);
      expect(live.activities[0]).toMatchObject({
        id: callId,
        turnId: qualifyId(scope.turnId, home.node),
        workerId: qualifyId(workerId, home.node),
        tool: AgentTool.DESKTOP,
        app: "Background App",
        windowId,
      });
      expect(toJsonString(ui.ThreadSnapshotSchema, live.snapshot)).not.toContain(callId);
      expect(
        await eventually(
          async () => (await viewer.links.mirror.snapshot(home.node, scope.threadId))?.thread?.id,
          (id) => id === threadId,
          20_000,
        ),
      ).toBe(threadId);
      expect(
        toJsonString(ui.ThreadSnapshotSchema, (await viewer.links.mirror.snapshot(home.node, scope.threadId))!),
      ).not.toContain(callId);
      await live.close();
      live = await watch(viewer.gateway.api, threadId);
      expect(live.activities).toEqual([]);
      expect(live.finished).toEqual([]);
      expect(live.resets).toEqual([]);
      const deviceCall = crypto.randomUUID();
      expect(
        (
          await authorize(
            gateway,
            scope,
            AgentTool.DEVICE,
            "snapshot",
            { platform: "android", serial: windowId },
            deviceCall,
          )
        ).isError,
      ).toBe(false);
      await live.until(1);
      expect(live.activities[0]).toMatchObject({ deviceId: windowId, platform: "android" });

      const replacement = await home.gateway.connect(workerId, credential, undefined, {
        hello: completionHello,
        resumeJournal: true,
      });

      await live.until(1, 0, 1);
      expect(live.resets).toEqual([deviceCall]);
      replacement.finish(scope.threadId, scope.turnId);
    } finally {
      await live?.close();
      await Promise.allSettled([viewer.close(), home.close()]);
    }
  },
  60_000,
);
