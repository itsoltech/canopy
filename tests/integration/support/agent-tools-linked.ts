import { expect } from "bun:test";
import { AgentTool, Provider } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { configComputer, pairConfig, type ConfigComputer } from "./config-sync.ts";
import { eventually, type ScriptedWorker } from "./gateway.ts";

/** Two linked gateways must route Canopy IDs while preserving the worker's opaque OS selectors. */
export async function expectLinkedAgentToolRouting(): Promise<void> {
  let viewer: ConfigComputer | undefined;
  let home: ConfigComputer | undefined;

  try {
    viewer = await configComputer("Automation viewer");
    home = await configComputer("Automation home");
    await pairConfig(viewer, home);
    const registered = await home.gateway.addWorker("Linked automation worker");

    const worker = await home.gateway.connect(registered.workerId, registered.credential, undefined, {
      hello: { capabilities: ["agent_tools_v1"] },
    });

    worker.handlers.set("runAgentTool", (operation, reply) => {
      if (!("operation" in operation)) throw new Error("expected automation operation");
      reply(true, { agentTool: { operation: operation.operation, text: "linked automation result" } });
    });
    worker.link.send({
      case: "agentToolsReport",
      value: {
        tools: [AgentTool.DEVICE, AgentTool.DESKTOP].map((tool) => ({
          tool,
          installed: true,
          ready: true,
          version: tool === AgentTool.DEVICE ? "0.21.37" : "1.3.1",
          screenshot: true,
        })),
      },
    });
    const workerId = qualifyId(registered.workerId, home.node);
    const api = viewer.gateway.api;

    const visible = await eventually(
      async () => (await api.getOverview({})).workers.find((item) => item.id === workerId),
      (item) => item?.agentTools.length === 2,
      20_000,
    );

    expect(visible?.agentTools.length).toBe(2);

    for (const tool of [AgentTool.DEVICE, AgentTool.DESKTOP])
      await api.setAgentToolEnabled({ workerId, tool, enabled: true });
    expect(await home.gateway.core.agentTools.readyTools(registered.workerId)).toEqual([
      AgentTool.DEVICE,
      AgentTool.DESKTOP,
    ]);

    const project = (await home.gateway.api.createProject({ name: "Linked automation session" })).project!;

    const workspace = (
      await home.gateway.api.createWorkspace({
        projectId: project.id,
        workerId: registered.workerId,
        rootPath: "/repo/linked-automation",
      })
    ).workspace!;

    const thread = (
      await home.gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
      })
    ).thread!;

    const deviceId = crypto.randomUUID();
    const windowId = crypto.randomUUID();
    const app = crypto.randomUUID();
    const plainSession = crypto.randomUUID();

    const operations = [
      {
        tool: AgentTool.DEVICE,
        operation: "snapshot",
        platform: "ios",
        deviceId,
        session: qualifyId(thread.id, home.node),
      },
      { tool: AgentTool.DESKTOP, operation: "snapshot", windowId, app, session: plainSession },
    ];

    for (const operation of operations) {
      const result = await api.runAgentTool({ workerId, operation });

      expect(result.result?.text).toBe("linked automation result");
      const sent = worker.commands.filter((command) => command.case === "runAgentTool").at(-1);

      expect(sent?.case).toBe("runAgentTool");
      expect(sent?.case === "runAgentTool" && sent.value).toMatchObject({
        ...operation,
        session: operation.tool === AgentTool.DEVICE ? thread.id : plainSession,
      });
    }

    expect(viewer.gateway.worker.commands.some((command) => command.case === "runAgentTool")).toBe(false);
    await home.gateway.api.setAgentToolEnabled({ workerId: registered.workerId, tool: AgentTool.DEVICE });

    const refused = await api.runAgentTool({ workerId, operation: operations[0] }).then(
      () => 0,
      (cause: unknown) => ConnectError.from(cause).code,
    );

    expect(refused).toBe(Code.PermissionDenied);
    expect(worker.commands.filter((command) => command.case === "runAgentTool")).toHaveLength(2);
    await expectLinkedInstallation(viewer, home, worker, registered.workerId);
    await expectTransientInstallationLog(viewer, home, worker, registered.workerId);
  } finally {
    await Promise.allSettled([viewer?.close(), home?.close()]);
  }
}

async function expectLinkedInstallation(
  viewer: ConfigComputer,
  home: ConfigComputer,
  worker: ScriptedWorker,
  workerId: string,
): Promise<void> {
  worker.link.send({
    case: "agentToolsReport",
    value: { tools: [{ tool: AgentTool.BROWSER, installed: false, installable: true }] },
  });

  const current = await eventually(
    async () => (await home.gateway.api.getOverview({})).workers.find((item) => item.id === workerId),
    (item) => item?.agentTools[0]?.tool?.tool === AgentTool.BROWSER,
  );

  expect(current?.agentTools[0]?.tool?.tool).toBe(AgentTool.BROWSER);
  await viewer.gateway.api.setAgentToolEnabled({
    workerId: qualifyId(workerId, home.node),
    tool: AgentTool.BROWSER,
    enabled: true,
  });
  const installations = worker.commands.filter((command) => command.case === "installAgentTool");
  expect(installations).toHaveLength(1);
  expect(installations[0]?.value).toMatchObject({ tool: AgentTool.BROWSER, installRuntime: true });
  const enabled = (await home.gateway.api.getOverview({})).workers.find((item) => item.id === workerId);
  expect(enabled?.agentTools[0]?.enabled).toBe(true);
  expect(viewer.gateway.worker.commands.some((command) => command.case === "installAgentTool")).toBe(false);
}

async function expectTransientInstallationLog(
  viewer: ConfigComputer,
  home: ConfigComputer,
  worker: ScriptedWorker,
  workerId: string,
): Promise<void> {
  const installId = crypto.randomUUID();
  const tool = AgentTool.DEVICE;
  const marker = "transient linked install output";

  worker.link.send({
    case: "agentToolsReport",
    value: { tools: [{ tool, installed: true, ready: false, install: { state: "running", installId } }] },
  });
  await eventually(
    async () => (await home.gateway.api.getOverview({})).workers.find((item) => item.id === workerId),
    (item) => item?.agentTools[0]?.tool?.install?.installId === installId,
  );
  worker.link.send({ case: "agentToolProgress", value: { tool, installId, lines: [marker] } });

  const live = await eventually(
    async () => (await home.gateway.api.getOverview({})).workers.find((item) => item.id === workerId),
    (item) => item?.agentTools[0]?.log.includes(marker) ?? false,
  );

  expect(live?.agentTools[0]?.log).toEqual([marker]);
  const mirroredInstallId = qualifyId(installId, home.node);

  const mirrored = await eventually(
    async () =>
      (await viewer.links.mirror.overview(home.node)).workers.find(
        (item) => item.id === qualifyId(workerId, home.node),
      ),
    (item) => item?.agentTools[0]?.tool?.install?.installId === mirroredInstallId,
    20_000,
  );

  expect(mirrored?.agentTools[0]?.tool?.install?.installId).toBe(mirroredInstallId);
  expect(mirrored?.agentTools[0]?.log).toEqual([]);
}
