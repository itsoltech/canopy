/** Owner defaults persist independently of workers and reach actual WorkerLink commands. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AgentTool, AgentToolSessionDefaultsSchema, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const defaults = create(AgentToolSessionDefaultsSchema, {
  browser: { viewportWidth: 1440, viewportHeight: 900, colorScheme: "dark" },
  desktop: { app: "Canopy", allowPhysicalInput: true },
  device: { platform: "ios", allowBoot: false, acquireTimeoutSeconds: 120 },
});

const code = (result: Promise<object>) =>
  result.then(
    () => 0,
    (cause: unknown) => ConnectError.from(cause).code,
  );

describe.skipIf(!dockerAvailable)("account agent-tool session defaults", () => {
  let gateway: TestGateway;

  const save = async (agentToolDefaults: MessageInitShape<typeof AgentToolSessionDefaultsSchema>) =>
    (
      await gateway.api.updateUserSettings({
        expectedVersion: (await gateway.api.getSettings({})).user!.version,
        agentToolDefaults,
      })
    ).settings!;

  beforeAll(async () => {
    gateway = await startTestGateway({ worker: { hello: { capabilities: ["agent_tools_v1", "agent_preview_v1"] } } });
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("persist across core restarts, isolate owners, reject stale versions and replace the whole section", async () => {
    const before = (await gateway.api.getSettings({})).user!;
    const saved = await save(defaults);
    expect(saved.agentToolDefaults).toEqual(defaults);
    expect(saved.version).toBe(before.version + 1n);

    const otherId = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("other-tool-defaults@localhost", "Other")),
    );

    const restarted = new GatewayCore({
      runtime: gateway.runtime,
      userId: gateway.userId,
      instanceId: "defaults-restart",
    });

    const other = new GatewayCore({ runtime: gateway.runtime, userId: otherId, instanceId: "defaults-other" });

    try {
      expect((await restarted.settings()).user?.agentToolDefaults).toEqual(defaults);
      expect((await other.settings()).user?.agentToolDefaults).toEqual(create(AgentToolSessionDefaultsSchema));
      expect(
        await code(gateway.api.updateUserSettings({ expectedVersion: before.version, agentToolDefaults: {} })),
      ).toBe(Code.FailedPrecondition);
      await gateway.api.updateUserSettings({ expectedVersion: saved.version, general: { confirmUnpin: true } });
      expect((await restarted.settings()).user?.agentToolDefaults).toEqual(defaults);
      const reset = await save({});
      expect(reset.agentToolDefaults).toEqual(create(AgentToolSessionDefaultsSchema));
      expect(reset.general?.confirmUnpin).toBe(true);
    } finally {
      restarted.secrets.stop();
      other.secrets.stop();
    }
  });

  test("validate dimensions, enum values, control characters and acquisition limits before writing", async () => {
    const before = (await gateway.api.getSettings({})).user!;

    const invalid: MessageInitShape<typeof AgentToolSessionDefaultsSchema>[] = [
      { browser: { viewportWidth: 1440 } },
      { browser: { viewportHeight: 900 } },
      { browser: { viewportWidth: 319, viewportHeight: 900 } },
      { browser: { viewportWidth: 1440, viewportHeight: 8193 } },
      { browser: { colorScheme: "system" } },
      { desktop: { app: "x".repeat(201) } },
      { desktop: { app: "Canopy\nOther" } },
      { desktop: { app: "Canopy\u0085Other" } },
      { device: { platform: "web" } },
      { device: { acquireTimeoutSeconds: 0 } },
      { device: { acquireTimeoutSeconds: 241 } },
    ];

    for (const agentToolDefaults of invalid)
      expect(await code(gateway.api.updateUserSettings({ expectedVersion: before.version, agentToolDefaults }))).toBe(
        Code.InvalidArgument,
      );
    expect((await gateway.api.getSettings({})).user).toEqual(before);

    for (const platform of ["", "ios", "android", "apple"])
      await save({
        browser: { viewportWidth: 320, viewportHeight: 8192, colorScheme: "no-preference" },
        desktop: { app: "x".repeat(200) },
        device: { platform, allowBoot: true, acquireTimeoutSeconds: platform ? 240 : 1 },
      });
  });

  test("dispatches the current owner defaults on thread creation, turns and preview starts, including resets", async () => {
    await save(defaults);
    const project = (await gateway.api.createProject({ name: "Session defaults" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project.id,
        workerId: gateway.workerId,
        rootPath: "/repo/defaults",
      })
    ).workspace!;

    const thread = (
      await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    await gateway.worker.createdThread(thread.id);

    const creation = gateway.worker.commands.find(
      (command) => command.case === "createThread" && command.value.thread?.threadId === thread.id,
    );

    expect(creation?.case === "createThread" && creation.value.thread?.agentToolDefaults).toEqual(defaults);

    const changed = await save({
      browser: { colorScheme: "light" },
      desktop: { allowPhysicalInput: false },
      device: { allowBoot: true },
    });

    const turn = (
      await gateway.api.sendMessage({
        threadId: thread.id,
        text: "Check defaults",
        clientRequestId: crypto.randomUUID(),
      })
    ).turn!;

    const start = await eventually(
      async () =>
        gateway.worker.commands.find((command) => command.case === "startTurn" && command.value.turnId === turn.id),
      Boolean,
    );

    expect(start?.case === "startTurn" && start.value.thread?.agentToolDefaults).toEqual(changed.agentToolDefaults);
    gateway.worker.link.send({
      case: "agentToolsReport",
      value: {
        tools: [
          {
            tool: AgentTool.BROWSER,
            installed: true,
            ready: true,
            screenshot: true,
            version: "0.43.0",
            detail: "defaults-ready",
          },
        ],
      },
    });
    await eventually(
      () => gateway.api.getOverview({}),
      (overview) =>
        overview.workers.find((worker) => worker.id === gateway.workerId)?.agentTools[0]?.tool?.detail ===
        "defaults-ready",
    );
    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER, enabled: true });
    gateway.worker.previewHandler = (command) => {
      if (command.kind.case === "start")
        gateway.worker.link.send({
          case: "agentPreview",
          value: { previewId: command.kind.value.previewId, state: "ready" },
        });
    };

    for (const expected of [changed.agentToolDefaults!, create(AgentToolSessionDefaultsSchema)]) {
      await save(expected);
      const abort = new AbortController();

      const stream = gateway.api
        .watchAgentPreview(
          { threadId: thread.id, scope: { tool: AgentTool.BROWSER } },
          { signal: abort.signal, timeoutMs: 0 },
        )
        [Symbol.asyncIterator]();

      try {
        const event = await stream.next();
        expect(event.value?.state).toBe("ready");

        const command = gateway.worker.previewCommands.find(
          (item) => item.kind.case === "start" && item.kind.value.previewId === event.value?.previewId,
        );

        expect(command?.kind.case === "start" && command.kind.value.agentToolDefaults).toEqual(expected);
      } finally {
        abort.abort();
        await stream.return?.();
      }
    }
  });
});
