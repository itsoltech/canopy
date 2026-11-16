import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import { AgentTool, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { type JsonObject } from "@canopy/domain";
import { qualifyId } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { GatewayStore } from "@canopy/gateway/store";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { configComputer, pairConfig } from "./support/config-sync.ts";

const tools = [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE];

async function running(gateway: TestGateway, mode = PermissionMode.FULL_AUTO) {
  gateway.worker.holdTurns = true;
  gateway.worker.link.send({
    case: "agentToolsReport",
    value: { tools: tools.map((tool) => ({ tool, installed: true, ready: true, version: "1.2.3" })) },
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

async function watch(api: TestGateway["api"], threadId: string, syncCursor?: ui.ThreadSyncCursor) {
  const abort = new AbortController();
  const activities: ui.ThreadAutomationActivity[] = [];
  let snapshot: ui.ThreadSnapshot | undefined;
  let ready = false;
  let failure: unknown;

  const reading = (async () => {
    try {
      for await (const update of api.watchThread(
        { threadId, sequence: true, syncCursor },
        { signal: abort.signal, timeoutMs: 0 },
      )) {
        snapshot = applyThreadUpdate(snapshot, update);

        if (update.change.case === "automationActivity") activities.push(update.change.value);

        if (update.change.case === "batch" && update.change.value.caughtUp) ready = true;
      }
    } catch (cause) {
      if (!abort.signal.aborted) failure = cause;
    }
  })();

  expect(await eventually(async () => ready, Boolean)).toBe(true);
  expect(failure).toBeUndefined();

  return {
    activities,
    get snapshot() {
      return snapshot!;
    },
    async until(count: number) {
      expect(
        await eventually(
          async () => activities.length,
          (length) => length === count,
        ),
      ).toBe(count);
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
      });
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
      const registered = await home.gateway.addWorker("Live automation");

      const worker = await home.gateway.connect(registered.workerId, registered.credential, undefined, {
        hello: { capabilities: ["agent_tools_v1"] },
      });

      // The helper uses the selected scripted worker, while RPC and persistence remain real.
      const gateway = { ...home.gateway, worker, workerId: registered.workerId };
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
      await live.until(1);
      expect(live.activities[0]).toMatchObject({
        id: callId,
        turnId: qualifyId(scope.turnId, home.node),
        workerId: qualifyId(registered.workerId, home.node),
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
      expect(
        (await authorize(gateway, scope, AgentTool.DEVICE, "snapshot", { platform: "android", serial: windowId }))
          .isError,
      ).toBe(false);
      await live.until(1);
      expect(live.activities[0]).toMatchObject({ deviceId: windowId, platform: "android" });
      worker.finish(scope.threadId, scope.turnId);
    } finally {
      await live?.close();
      await Promise.allSettled([viewer.close(), home.close()]);
    }
  },
  60_000,
);
