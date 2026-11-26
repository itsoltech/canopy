import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import {
  eventually,
  SCRIPTED_MODELS,
  startTestGateway,
  type ScriptedWorker,
  type TestGateway,
} from "./support/gateway.ts";

const target = {
  project: "Release operations",
  worker: "Build studio",
  workspace: "Release checkout",
};

const targetPath = "/studio/release";

const claudeCatalog = {
  provider: Provider.CLAUDE,
  profileId: "native",
  models: [{ id: "opus", displayName: "Opus", isDefault: true, efforts: ["low", "high"] }],
};

let gw: TestGateway;
let studio: ScriptedWorker;
let studioId: string;
let sourceProjectId: string;
let sourceWorkspaceId: string;
let targetWorkspace: ui.Workspace;
let laptopReleaseWorkspace: ui.Workspace;

function result<T>(reply: AgentToolResult): T {
  expect(reply.isError).toBe(false);

  // SAFETY: A successful tool response contains the JSON result from the gateway for the tool under test.
  return JSON.parse(reply.resultJson) as T;
}

function createCaller(title: string) {
  return gw.api.createThread({
    projectId: sourceProjectId,
    workspaceId: sourceWorkspaceId,
    title,
    provider: Provider.CODEX,
    permissionMode: PermissionMode.ASK,
  });
}

const turnsOf = (threadId: string) => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(threadId)));

async function waitForTurn(threadId: string, turnId: string, status: "running" | "completed") {
  const turns = await eventually(
    () => turnsOf(threadId),
    (rows) => rows.some((turn) => turn.id === turnId && turn.status === status),
  );

  expect(turns.find((turn) => turn.id === turnId)?.status).toBe(status);
}

describe.skipIf(!dockerAvailable)("agent starts independent threads (gateway + scripted workers)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const added = await gw.addWorker(target.worker, ["/studio"]);
    studioId = added.workerId;
    studio = await gw.connect(studioId, added.credential, undefined, {
      claude: true,
      models: [...SCRIPTED_MODELS, claudeCatalog],
    });
    await eventually(
      () => gw.api.getOverview({}),
      (overview) =>
        overview.workers.some(
          (worker) =>
            worker.id === studioId &&
            worker.appliedVersion > 0n &&
            worker.providerInstances.some((instance) => instance.harness === Provider.CLAUDE && instance.available),
        ),
    );
    await eventually(
      () => gw.api.listModels({}),
      (response) => response.workers.some((worker) => worker.workerId === studioId && worker.configVersion > 0n),
    );

    sourceProjectId = (await gw.api.createProject({ name: "Planning" })).project!.id;
    sourceWorkspaceId = (
      await gw.api.createWorkspace({
        projectId: sourceProjectId,
        workerId: gw.workerId,
        rootPath: "/repo/planning",
        label: "Planning checkout",
      })
    ).workspace!.id;
    const projectId = (await gw.api.createProject({ name: target.project })).project!.id;
    laptopReleaseWorkspace = (
      await gw.api.createWorkspace({
        projectId,
        workerId: gw.workerId,
        rootPath: "/repo/release",
        label: target.workspace,
      })
    ).workspace!;
    await gw.api.createWorkspace({
      projectId,
      workerId: studioId,
      rootPath: "/studio/sandbox",
      label: "Sandbox checkout",
    });
    targetWorkspace = (
      await gw.api.createWorkspace({
        projectId,
        workerId: studioId,
        rootPath: targetPath,
        label: target.workspace,
      })
    ).workspace!;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("lists the chosen project's destinations and worker's models, and refuses an ambiguous workspace name", async () => {
    const caller = (await createCaller("Catalog reader")).thread!;
    const list = { threadId: caller.id, tool: "list_agents" };
    const project = result(await gw.worker.callTool({ ...list, args: { project: target.project } }));

    expect(project).toMatchObject({
      projects: [
        {
          project_id: targetWorkspace.projectId,
          name: target.project,
          workspaces: expect.arrayContaining([
            expect.objectContaining({
              workspace_id: laptopReleaseWorkspace.id,
              worker_id: gw.workerId,
              name: target.workspace,
            }),
            expect.objectContaining({
              workspace_id: targetWorkspace.id,
              worker_id: studioId,
              name: target.workspace,
              path: targetPath,
            }),
          ]),
        },
      ],
    });

    const filtered = result(
      await gw.worker.callTool({ ...list, args: { project: target.project, worker: target.worker } }),
    );

    expect(filtered).toMatchObject({
      workers: [{ worker_id: studioId, name: target.worker, online: true }],
      agents: expect.arrayContaining([
        expect.objectContaining({
          provider: "claude/native",
          models: [{ id: "opus", name: "Opus", efforts: ["low", "high"], default: true }],
        }),
      ]),
    });

    const refused = await gw.worker.callTool({
      threadId: caller.id,
      tool: "start_thread",
      args: { project: target.project, workspace: target.workspace, title: "Ambiguous release", prompt: "Review." },
    });

    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Multiple destinations match");
    expect(refused.content).toContain(laptopReleaseWorkspace.id);
    expect(refused.content).toContain(targetWorkspace.id);
  }, 30_000);

  test("starts a top-level thread, reports back by default, and replays the same call result", async () => {
    const caller = (await createCaller("Release coordinator")).thread!;

    const ready = await eventually(
      () => gw.api.getThread({ threadId: caller.id }),
      (response) => response.thread?.status === "idle",
    );

    expect(ready.thread?.status).toBe("idle");
    const title = "Release checklist";
    const prompt = "Draft the checklist for the November release.";
    const instructions = "Use the release runbook.";

    const call = {
      threadId: caller.id,
      tool: "start_thread",
      callId: Bun.randomUUIDv7(),
      args: {
        ...target,
        title,
        prompt,
        instructions,
        provider: "claude/native",
        model: "opus",
        effort: "high",
      },
    };

    const started = result<{ thread_id: string; turn_id: string }>(await gw.worker.callTool(call));

    expect(started).toMatchObject({
      project_id: targetWorkspace.projectId,
      workspace_id: targetWorkspace.id,
      worker_id: studioId,
      provider: "claude/native",
      model: "opus",
    });
    const threadId = started.thread_id;
    const created = await studio.createdThread(threadId);

    expect(created).toMatchObject({
      depth: 0,
      cwd: targetPath,
      provider: Provider.CLAUDE,
      model: "opus",
    });
    expect(created?.instructions).toContain(instructions);

    await waitForTurn(threadId, started.turn_id, "completed");
    expect(studio.started.get(started.turn_id)?.text).toContain(prompt);
    expect(studio.turnSettings.get(started.turn_id)).toEqual({ model: "opus", effort: "high" });
    expect(gw.worker.created.some((thread) => thread.threadId === threadId)).toBe(false);

    const reports = await eventually(
      () => turnsOf(caller.id),
      (rows) => rows[0]?.status === "completed",
    );

    expect(reports).toMatchObject([{ trigger: "agent_bus", status: "completed" }]);
    expect(gw.worker.started.get(reports[0]!.id)?.text).toContain(
      `"${title}" (thread_id: ${threadId}) finished a turn: completed`,
    );

    const replayed = result(await gw.worker.callTool(call));
    expect(replayed).toEqual(started);
    const threads = (await gw.api.listThreads({ includeArchived: true })).threads;
    expect(threads.filter((thread) => thread.title === title)).toMatchObject([
      {
        id: threadId,
        kind: ui.ThreadKind.MAIN,
        parentThreadId: "",
        rootThreadId: threadId,
        projectId: targetWorkspace.projectId,
        workspaceId: targetWorkspace.id,
        workerId: studioId,
        cwd: targetPath,
      },
    ]);
    expect((await turnsOf(threadId)).map((turn) => turn.id)).toEqual([started.turn_id]);
  }, 30_000);

  test("a thread started by ID respects the active calling turn's permission ceiling", async () => {
    const caller = (await createCaller("Restricted coordinator")).thread!;
    gw.worker.holdTurns = true;
    let turnId = "";

    try {
      const sent = await gw.api.sendMessage({
        threadId: caller.id,
        text: "Inspect the release configuration.",
        permissionMode: PermissionMode.READ_ONLY,
        clientRequestId: Bun.randomUUIDv7(),
      });

      turnId = sent.turn!.id;

      const modes = await eventually(
        async () => gw.worker.turnModes.get(turnId),
        (mode) => mode !== undefined,
      );

      expect(modes).toEqual({ turn: PermissionMode.READ_ONLY, thread: PermissionMode.ASK });
      await waitForTurn(caller.id, turnId, "running");
      const title = "Permissions exceed the active turn";

      const call = {
        threadId: caller.id,
        turnId,
        tool: "start_thread",
        args: {
          project: targetWorkspace.projectId,
          worker: studioId,
          workspace: targetWorkspace.id,
          title,
          prompt: "Inspect the release configuration.",
          notify: false,
        },
      };

      const refused = await gw.worker.callTool({
        ...call,
        args: {
          ...call.args,
          permission_mode: "ask",
        },
      });

      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("read_only");
      const threads = (await gw.api.listThreads({ projectId: targetWorkspace.projectId })).threads;
      expect(threads.some((thread) => thread.title === title)).toBe(false);

      const started = result<{ thread_id: string; turn_id: string }>(
        await gw.worker.callTool({ ...call, args: { ...call.args, title: "Read-only release inspection" } }),
      );

      await waitForTurn(started.thread_id, started.turn_id, "completed");
      expect(studio.turnModes.get(started.turn_id)).toEqual({
        turn: PermissionMode.READ_ONLY,
        thread: PermissionMode.READ_ONLY,
      });
    } finally {
      gw.worker.holdTurns = false;

      if (turnId) {
        if (gw.worker.started.has(turnId)) gw.worker.finish(caller.id, turnId);
        await waitForTurn(caller.id, turnId, "completed");
      }
    }
  }, 30_000);

  test("a project belonging to another owner cannot be selected by ID", async () => {
    const foreign = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* GatewayStore;
        const owner = yield* store.ensureUser("other@localhost", "Other owner");

        return yield* store.createProject(owner, "Private release");
      }),
    );

    const caller = (await createCaller("Owner scope check")).thread!;

    const refused = await gw.worker.callTool({
      threadId: caller.id,
      tool: "start_thread",
      args: { project: foreign.id, title: "Private launch", prompt: "Inspect the configuration." },
    });

    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/project.*not found/i);
  }, 30_000);
});
