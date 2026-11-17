import { expect } from "bun:test";
import { AgentTool, Provider, type AgentPreviewEvent } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { configComputer, pairConfig, type ConfigComputer } from "./config-sync.ts";
import { eventually } from "./gateway.ts";

/** A live preview routes only the thread entity; native targets and preview IDs remain opaque. */
export function expectLinkedAgentPreview(): Promise<void> {
  return linkedAgentPreview(false);
}

export function expectLinkedAgentPreviewWithClientAck(): Promise<void> {
  return linkedAgentPreview(true);
}

async function linkedAgentPreview(clientAck: boolean): Promise<void> {
  let viewer: ConfigComputer | undefined;
  let home: ConfigComputer | undefined;
  const abort = new AbortController();
  let consume: Promise<void> | undefined;

  try {
    viewer = await configComputer("Preview viewer");
    home = await configComputer("Preview home");
    await pairConfig(viewer, home);
    const registered = await home.gateway.addWorker("Interactive preview worker");

    const worker = await home.gateway.connect(registered.workerId, registered.credential, undefined, {
      hello: { capabilities: ["agent_tools_v1", "agent_preview_v1"] },
    });

    const deviceId = crypto.randomUUID();
    const windowId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const events: AgentPreviewEvent[] = [];

    worker.previewHandler = (command) => {
      if (command.kind.case !== "start") return;
      worker.link.send({
        case: "agentPreview",
        value: {
          previewId: command.kind.value.previewId,
          state: "ready",
          targetId,
          targets: [{ id: targetId, label: "Linked simulator", deviceId, windowId }],
        },
      });
    };

    worker.link.send({
      case: "agentToolsReport",
      value: {
        tools: [{ tool: AgentTool.DEVICE, installed: true, ready: true, version: "0.21.37" }],
      },
    });
    const remoteWorker = qualifyId(registered.workerId, home.node);
    const api = viewer.gateway.api;

    await eventually(
      async () => (await api.getOverview({})).workers.find((item) => item.id === remoteWorker),
      (item) => item?.agentTools[0]?.tool?.ready === true,
      20_000,
    );
    await api.setAgentToolEnabled({ workerId: remoteWorker, tool: AgentTool.DEVICE, enabled: true });
    const project = (await home.gateway.api.createProject({ name: "Linked interactive preview" })).project!;

    const workspace = (
      await home.gateway.api.createWorkspace({
        projectId: project.id,
        workerId: registered.workerId,
        rootPath: "/repo/linked-preview",
      })
    ).workspace!;

    const thread = (
      await home.gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
      })
    ).thread!;

    const threadId = qualifyId(thread.id, home.node);

    consume = (async () => {
      try {
        for await (const event of api.watchAgentPreview(
          { threadId, scope: { tool: AgentTool.DEVICE, platform: "ios", deviceId }, clientAck },
          { signal: abort.signal, timeoutMs: 0 },
        ))
          events.push(event);
      } catch (cause) {
        if (!abort.signal.aborted) throw cause;
      }
    })();
    await eventually(
      async () => events.length,
      (count) => count === 1,
    );
    const start = worker.previewCommands.find((command) => command.kind.case === "start")?.kind;

    expect(start?.case).toBe("start");
    expect(start?.case === "start" && start.value).toMatchObject({
      threadId: thread.id,
      previewId: events[0]?.previewId,
      scope: { session: thread.id, deviceId, platform: "ios" },
    });
    expect(events[0]).toMatchObject({ targetId, targets: [{ id: targetId, deviceId, windowId }] });
    expect(events[0]?.previewId).not.toContain("~");

    const data = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGLsAAAAASUVORK5CYII=",
      "base64",
    );

    worker.link.send({
      case: "agentPreview",
      value: {
        previewId: events[0]!.previewId,
        state: "frame",
        frameId: 1n,
        data,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
    });
    await eventually(
      async () => events.length,
      (count) => count === 2,
    );
    expect(events[1]).toMatchObject({ previewId: events[0]?.previewId, state: "frame", frameId: 1n });
    expect(events[1]?.data).toEqual(new Uint8Array(data));

    if (clientAck) {
      await eventually(
        async () => worker.previewCommands.some((command) => command.kind.case === "ack"),
        Boolean,
        2000,
      );
      expect(
        worker.previewCommands.some((command) => command.kind.case === "ack" && command.kind.value.frameId > 0n),
      ).toBe(false);
      await api.ackAgentPreview({ threadId, previewId: events[0]!.previewId, frameId: 1n });
    }

    expect(
      await eventually(
        async () =>
          worker.previewCommands.some((command) => command.kind.case === "ack" && command.kind.value.frameId === 1n),
        Boolean,
      ),
    ).toBe(true);
    await api.sendAgentPreviewInput({
      threadId,
      previewId: events[0]!.previewId,
      inputs: [
        { kind: "pointer-down", x: 0.25, y: 0.75 },
        { kind: "pointer-up", x: 0.25, y: 0.75 },
      ],
    });
    await eventually(async () => worker.previewCommands.some((command) => command.kind.case === "input"), Boolean);
    expect(worker.previewCommands.find((command) => command.kind.case === "input")?.kind.value).toMatchObject({
      previewId: events[0]?.previewId,
    });
    expect(viewer.gateway.worker.previewCommands).toEqual([]);
    abort.abort();
    await consume;
    expect(
      await eventually(
        async () => worker.previewCommands.filter((command) => command.kind.case === "stop").length,
        (count) => count === 1,
      ),
    ).toBe(1);
    expect(home.gateway.core.link.connections.get(registered.workerId)?.previewWatches.size).toBe(0);
  } finally {
    abort.abort();
    await consume?.catch(() => {});
    await Promise.allSettled([viewer?.close(), home?.close()]);
  }
}
