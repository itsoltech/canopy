import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InteractionKind, PermissionMode, Provider, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { Schema } from "effect";

const spawned = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ thread_id: Schema.String, turn_id: Schema.String })),
);

describe.skipIf(!dockerAvailable)("linked agent delivery without local bots", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let parent: string;
  let project: string;
  let workspace: string;

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });

    for (const gw of [a, b]) {
      const computers = linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

      gw.core.computers = computers;
      gw.core.network = computers.options.network;
      await computers.start();

      if (gw === a) la = computers;
      else lb = computers;
    }

    const pairing = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: pairing.code });
    expect(await eventually(async () => la.canCall(lb.hello().nodeId) && lb.canCall(la.hello().nodeId), Boolean)).toBe(
      true,
    );
    project = (await b.api.createProject({ name: "Remote project" })).project!.id;
    workspace = (await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo" }))
      .workspace!.id;
    const localProject = (await a.api.createProject({ name: "Parent project" })).project!.id;

    const localWorkspace = (
      await a.api.createWorkspace({ projectId: localProject, workerId: a.workerId, rootPath: "/repo" })
    ).workspace!.id;

    parent = (
      await a.api.createThread({
        projectId: localProject,
        workspaceId: localWorkspace,
        title: "Parent",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
    b.worker.holdTurns = true;
    a.core.bots.start();
    b.core.bots.start();
  }, 60_000);
  afterAll(async () => {
    await a?.core.bots.stop();
    await b?.core.bots.stop();
    await la?.close();
    await lb?.close();
    await a?.close();
    await b?.close();
  });

  async function child(title: string) {
    const node = lb.hello().nodeId;

    const result = await a.worker.callTool({
      threadId: parent,
      tool: "spawn_thread",
      args: {
        project_id: qualifyId(project, node),
        workspace_id: qualifyId(workspace, node),
        title,
        prompt: title,
        provider: "codex/native",
      },
    });

    expect(result.isError, result.content).toBe(false);
    const reference = spawned(result.resultJson);
    const threadId = reference.thread_id.split("~")[0]!;
    const turnId = reference.turn_id.split("~")[0]!;
    expect(await eventually(async () => b.worker.started.has(turnId), Boolean)).toBe(true);

    // Arm the five-second local preflight backoff before the linked event exists.
    expect(await b.core.bots.run((s) => s.poll(b.userId, new Date()))).toMatchObject({
      configured: false,
      ready: false,
    });
    await b.core.bots.tick();

    return { threadId, turnId };
  }

  test("a completion report reaches its parent while local bot polling is backed off", async () => {
    const { threadId, turnId } = await child("Idle completion report");
    const started = performance.now();
    b.worker.finish(threadId, turnId, "Idle child result");

    const delivered = await eventually(
      async () => (a.worker.inputs.get(parent) ?? []).some((text) => text.includes("Idle child result")),
      Boolean,
      1500,
    );

    expect(delivered).toBe(true);
    console.info("botless-linked-report-ms", performance.now() - started);
  });

  test("a permission question reaches its parent while local bot polling is backed off", async () => {
    const { threadId } = await child("Idle permission question");
    const requestId = crypto.randomUUID();
    const started = performance.now();
    b.worker.ask({ requestId, threadId, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: "{}" });

    const delivered = await eventually(
      async () =>
        (a.worker.inputs.get(parent) ?? []).some((text) => text.includes(qualifyId(requestId, lb.hello().nodeId))),
      Boolean,
      1500,
    );

    expect(delivered).toBe(true);
    console.info("botless-linked-question-ms", performance.now() - started);
  });

  test("starts a top-level thread by project name on a linked computer and gets its report", async () => {
    const node = lb.hello().nodeId;
    const worker = (await b.api.getOverview({})).workers.find((item) => item.id === b.workerId)!;
    const discovery = { project: "Remote project", worker: worker.name };

    const catalog = await eventually(
      () => a.worker.callTool({ threadId: parent, tool: "list_agents", args: discovery }),
      (reply) => !reply.isError && reply.resultJson.includes(qualifyId(workspace, node)),
    );

    expect(catalog.isError, catalog.content).toBe(false);
    const title = "Independent remote thread";

    const call = {
      threadId: parent,
      tool: "start_thread",
      callId: Bun.randomUUIDv7(),
      args: { ...discovery, title, prompt: title, workspace_mode: "checkout" },
    };

    const reply = await a.worker.callTool(call);

    expect(reply.isError, reply.content).toBe(false);
    const reference = spawned(reply.resultJson);
    const threadId = reference.thread_id.split("~")[0]!;
    const turnId = reference.turn_id.split("~")[0]!;

    expect(reference.thread_id).toBe(qualifyId(threadId, node));
    expect((await b.api.getThread({ threadId })).thread).toMatchObject({
      title,
      kind: ui.ThreadKind.MAIN,
      parentThreadId: "",
      rootThreadId: threadId,
      interactionRoute: "human",
      projectId: project,
      workspaceId: workspace,
      workerId: b.workerId,
    });

    const input = await eventually(
      async () => b.worker.started.get(turnId),
      (item) => !!item,
    );

    expect(input?.text).toContain(title);
    const replay = await a.worker.callTool(call);

    expect(replay.isError, replay.content).toBe(false);
    expect(spawned(replay.resultJson)).toEqual(reference);
    b.worker.finish(threadId, turnId, "Independent remote result");

    const reported = await eventually(
      async () => (a.worker.inputs.get(parent) ?? []).some((message) => message.includes("Independent remote result")),
      Boolean,
    );

    expect(reported).toBe(true);
  });
});
