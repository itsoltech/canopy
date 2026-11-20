/**
 * A per-turn permission override is the ceiling for subagents while the parent
 * thread's default remains the fallback when there is no calling turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let worker: ScriptedWorker;
let projectId = "";
let workspaceId = "";
const activeParents = new Map<string, string>();
const activeChildren = new Map<string, { parentId: string; turnId: string }>();

const modes = [
  { api: PermissionMode.FULL_AUTO, name: "FULL_AUTO" },
  { api: PermissionMode.FULL_ACCESS, name: "FULL_ACCESS" },
] as const;

const turns = (threadId: string) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{
        id: string;
        status: string;
        permission_mode: string;
        thread_permission_mode: string;
      }>`
        SELECT id, status, permission_mode, thread_permission_mode
          FROM turns WHERE thread_id = ${threadId}::uuid ORDER BY ordinal`;
    }),
  );

const turnSettings = (turnId: string) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (yield* sql<{ permission_mode: string; thread_permission_mode: string }>`
        SELECT permission_mode, thread_permission_mode FROM turns WHERE id = ${turnId}::uuid`)[0];
    }),
  );

const json = (result: AgentToolResult) => {
  expect(result.isError).toBe(false);

  // SAFETY: Successful spawn_thread results contain the stored child and first-turn identifiers and permission mode.
  return JSON.parse(result.resultJson) as {
    thread_id: string;
    turn_id: string;
    permission_mode: string;
  };
};

async function spawn(
  parentId: string,
  turnId: string | undefined,
  title: string,
  permission_mode?: "read_only" | "ask",
) {
  const result = await worker.callTool({
    threadId: parentId,
    ...(turnId !== undefined && { turnId }),
    tool: "spawn_thread",
    args: { title, prompt: "inspect", notify: false, ...(permission_mode && { permission_mode }) },
  });

  const child = json(result);
  activeChildren.set(child.thread_id, { parentId, turnId: child.turn_id });
  const spec = await worker.createdThread(child.thread_id);

  const delivered = await eventually(
    async () => worker.turnModes.get(child.turn_id),
    (value) => value !== undefined,
  );

  const view = await eventually(
    () => gw.api.getThread({ threadId: child.thread_id }),
    (value) => value.thread !== undefined,
  );

  if (!spec || !delivered || !view.thread) throw new Error("child did not reach the worker and API");

  return { child, spec, delivered, apiMode: view.thread.permissionMode };
}

async function closeChild(parentId: string, childId: string) {
  const childTurnId = activeChildren.get(childId)?.turnId;
  const childTurns = await turns(childId);

  if (childTurnId && childTurns.some((row) => row.status === "running")) worker.finish(childId, childTurnId);

  const result = await worker.callTool({ threadId: parentId, tool: "close_thread", args: { thread_id: childId } });
  expect(result.isError).toBe(false);
  await eventually(
    () => turns(childId),
    (rows) => rows.length > 0 && rows.every((row) => row.status !== "queued" && row.status !== "running"),
  );
}

async function settleParent(parentId: string, turnId: string) {
  const parentTurns = await turns(parentId);

  if (parentTurns.some((row) => row.status === "running")) worker.finish(parentId, turnId);
  await eventually(
    () => turns(parentId),
    (rows) => rows.length > 0 && rows.every((row) => row.status !== "queued" && row.status !== "running"),
  );
}

describe.skipIf(!dockerAvailable)("subagent permission inheritance (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: ["full_access"] } } });
    worker = gw.worker;
    projectId = (await gw.api.createProject({ name: "Subagent permissions" })).project!.id;
    workspaceId = (
      await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/permissions", label: "" })
    ).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  afterEach(async () => {
    if (!worker) return;

    worker.holdTurns = false;

    try {
      for (const [childId, child] of activeChildren) await closeChild(child.parentId, childId);

      for (const [parentId, turnId] of activeParents) await settleParent(parentId, turnId);
    } finally {
      activeChildren.clear();
      activeParents.clear();
    }
  });

  test("broad per-turn overrides reach the worker and child API; an explicit narrower mode wins", async () => {
    worker.holdTurns = true;

    for (const mode of modes) {
      const parent = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          provider: Provider.CODEX,
          title: `${mode.name} parent`,
          permissionMode: PermissionMode.ASK,
        })
      ).thread!;

      const sent = await gw.api.sendMessage({
        threadId: parent.id,
        text: "delegate",
        permissionMode: mode.api,
        clientRequestId: `inherit-${mode.name}`,
      });

      const turnId = sent.turn!.id;
      activeParents.set(parent.id, turnId);

      const parentMode = await eventually(
        async () => worker.turnModes.get(turnId),
        (value) => value !== undefined,
      );

      expect(parentMode).toEqual({ turn: mode.api, thread: PermissionMode.ASK });
      expect(await turnSettings(turnId)).toEqual({ permission_mode: mode.name, thread_permission_mode: "ASK" });

      const inherited = await spawn(parent.id, turnId, `${mode.name} child`);
      expect(inherited.child.permission_mode).toBe(mode.name.toLowerCase());
      expect(inherited.apiMode).toBe(mode.api);
      expect(inherited.spec.permissionMode).toBe(mode.api);
      expect(inherited.delivered).toEqual({ turn: mode.api, thread: mode.api });

      const narrowed = await spawn(parent.id, turnId, `${mode.name} read only`, "read_only");
      expect(narrowed.child.permission_mode).toBe("read_only");
      expect(narrowed.apiMode).toBe(PermissionMode.READ_ONLY);
      expect(narrowed.spec.permissionMode).toBe(PermissionMode.READ_ONLY);
      expect(narrowed.delivered).toEqual({ turn: PermissionMode.READ_ONLY, thread: PermissionMode.READ_ONLY });
    }
  });

  test("a current default lowers the ceiling immediately, and raising it cannot raise the active turn", async () => {
    worker.holdTurns = true;

    const parent = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Active turn ceiling",
        permissionMode: PermissionMode.ASK,
      })
    ).thread!;

    const sent = await gw.api.sendMessage({
      threadId: parent.id,
      text: "delegate with a temporary broad mode",
      permissionMode: PermissionMode.FULL_AUTO,
      clientRequestId: "active-ceiling",
    });

    const turnId = sent.turn!.id;
    activeParents.set(parent.id, turnId);
    await eventually(
      async () => worker.turnModes.get(turnId),
      (value) => value !== undefined,
    );

    const lowered = await gw.api.updateThread({ threadId: parent.id, permissionMode: PermissionMode.READ_ONLY });
    expect(lowered.thread?.permissionMode).toBe(PermissionMode.READ_ONLY);
    const lowChild = await spawn(parent.id, turnId, "lowered child");
    expect(lowChild.apiMode).toBe(PermissionMode.READ_ONLY);

    const raised = await gw.api.updateThread({ threadId: parent.id, permissionMode: PermissionMode.FULL_ACCESS });
    expect(raised.thread?.permissionMode).toBe(PermissionMode.FULL_ACCESS);
    const raisedChild = await spawn(parent.id, turnId, "raised child");
    expect(raisedChild.apiMode).toBe(PermissionMode.FULL_AUTO);
    expect(raisedChild.spec.permissionMode).toBe(PermissionMode.FULL_AUTO);

    // An active turn from before snapshot plumbing must conservatively use the current default.
    await gw.api.updateThread({ threadId: parent.id, permissionMode: PermissionMode.ASK });
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE turns SET thread_permission_mode = '' WHERE id = ${turnId}::uuid`;
      }),
    );
    const legacyChild = await spawn(parent.id, turnId, "legacy snapshot child");
    expect(legacyChild.apiMode).toBe(PermissionMode.ASK);
    expect(legacyChild.spec.permissionMode).toBe(PermissionMode.ASK);
  });

  test("an idle call can inherit or narrow the thread default and rejects an unknown turn ID", async () => {
    worker.holdTurns = true;

    const parent = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Idle fallback",
        permissionMode: PermissionMode.FULL_AUTO,
      })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: parent.id }),
      (value) => value.thread?.status === "idle",
    );

    const idle = await spawn(parent.id, undefined, "idle child");
    expect(idle.child.permission_mode).toBe("full_auto");
    expect(idle.apiMode).toBe(PermissionMode.FULL_AUTO);

    const missing = await worker.callTool({
      threadId: parent.id,
      turnId: Bun.randomUUIDv7(),
      tool: "spawn_thread",
      args: { title: "missing turn child", prompt: "inspect", notify: false },
    });

    expect(missing.isError).toBe(true);
    expect(missing.content).toBe("This tool call is outside the current turn context.");

    const narrowed = await spawn(parent.id, undefined, "idle read only", "read_only");
    expect(narrowed.child.permission_mode).toBe("read_only");
    expect(narrowed.apiMode).toBe(PermissionMode.READ_ONLY);
  });
});
