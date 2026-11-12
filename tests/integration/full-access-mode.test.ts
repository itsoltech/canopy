/**
 * Full access (PERMISSION_MODE_FULL_ACCESS, docs/protocol.md): round-trips through CreateThread, UpdateThread
 * and SendMessage to a worker that announces `full_access`; a worker without it gets a readable refusal and
 * never a turn in another mode; user forks require opting in again, while agents inherit the owner's mode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider, ui, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { AgentToolCallSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { codexPermissions } from "../../apps/worker/src/providers/codex/permissions.ts";
import { claudePermissions } from "../../apps/worker/src/providers/claude/permissions.ts";
import { grokLaunch } from "../../apps/worker/src/providers/grok/launch.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let modern: ScriptedWorker;
let projectId = "";

/** On the scripted worker of startTestGateway: no `full_access` capability (an older worker). */
let oldWorkspace = "";

/** On a worker that announces `full_access`. */
let workspaceId = "";
const tempDir = tempDirs();

/** Feed the actual child mode delivered over the worker link into each native harness adapter. */
function nativeChildMode(mode: PermissionMode) {
  const bypass = mode === PermissionMode.FULL_ACCESS;
  expect(codexPermissions(mode)).toEqual({
    approvalPolicy: "never",
    sandbox: bypass ? "danger-full-access" : "read-only",
  });
  expect(claudePermissions(mode, "linux")).toEqual({
    options: { permissionMode: bypass ? "acceptEdits" : "dontAsk", ...(bypass && { sandbox: { enabled: false } }) },
    autoAllow: bypass ? "all" : "none",
  });

  const launch = grokLaunch({
    dataDir: tempDir("canopy-child-mode-"),
    profile: { id: "native", kind: "native", providers: ["grok"], env: {}, runtime: {} },
    linkDeviceLogin: false,
    baseEnv: {},
    readOnly: mode === PermissionMode.READ_ONLY,
    fullAccess: bypass,
  });

  try {
    expect(launch.options.env?.["GROK_SANDBOX"]).toBe(bypass ? "off" : "read-only");
  } finally {
    launch.cleanup();
  }
}

const REFUSED = "Full access is not available on this computer";

const turns = (threadId: string) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{
        id: string;
        status: string;
        permission_mode: string;
        error: string | null;
        error_code: string | null;
      }>`
        SELECT id, status, permission_mode, error, error_code FROM turns WHERE thread_id = ${threadId}::uuid ORDER BY ordinal`;
    }),
  );

const settled = (threadId: string, count: number) =>
  eventually(
    () => turns(threadId),
    (t) => t.length === count && t.every((x) => x.status !== "queued" && x.status !== "running"),
  );

const json = (result: AgentToolResult) => JSON.parse(result.content) as { thread_id: string; permission_mode: string };

describe.skipIf(!dockerAvailable)("full access mode (gateway + scripted workers)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const added = await gw.addWorker("modern");
    modern = await gw.connect(added.workerId, added.credential, undefined, {
      hello: { capabilities: ["full_access"] },
    });
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === added.workerId && w.appliedVersion > 0n),
    );
    projectId = (await gw.api.createProject({ name: "Full access" })).project!.id;
    oldWorkspace = (
      await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "old" })
    ).workspace!.id;
    workspaceId = (
      await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: "/repo/app", label: "new" })
    ).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("round-trips through CreateThread, UpdateThread and SendMessage; owner only; a fork does not inherit it", async () => {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Outside the workspace",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.FULL_ACCESS,
        initialMessage: "write ~/notes.txt",
        clientRequestId: "full-access-create",
      })
    ).thread!;

    expect(thread.permissionMode).toBe(PermissionMode.FULL_ACCESS);
    const [first] = await settled(thread.id, 1);
    expect([first!.status, first!.permission_mode]).toEqual(["completed", "FULL_ACCESS"]);
    expect(modern.created.find((c) => c.threadId === thread.id)?.permissionMode).toBe(PermissionMode.FULL_ACCESS);
    expect(modern.turnModes.get(first!.id)).toEqual({
      turn: PermissionMode.FULL_ACCESS,
      thread: PermissionMode.FULL_ACCESS,
    });

    // Back to Ask as the default, then one message in Full access.
    await gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.ASK });
    await gw.api.sendMessage({
      threadId: thread.id,
      text: "once more",
      permissionMode: PermissionMode.FULL_ACCESS,
      clientRequestId: "full-access-once",
    });
    const [, once] = await settled(thread.id, 2);
    expect(modern.turnModes.get(once!.id)).toEqual({ turn: PermissionMode.FULL_ACCESS, thread: PermissionMode.ASK });

    const updated = await gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.FULL_ACCESS });
    expect(updated.thread?.permissionMode).toBe(PermissionMode.FULL_ACCESS);
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.permissionMode).toBe(PermissionMode.FULL_ACCESS);

    // Another user can neither set it nor see the thread.
    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other-full@test", "Other")));
    const stranger = new GatewayCore({ runtime: gw.runtime, instanceId: "full-stranger", userId: other });

    const strangerThread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Mine",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
      })
    ).thread!;

    expect(
      await failure(
        stranger.updateThread(
          create(ui.UpdateThreadRequestSchema, {
            threadId: strangerThread.id,
            permissionMode: PermissionMode.FULL_ACCESS,
          }),
        ),
      ),
    ).toContain("thread not found");
    expect(
      await failure(
        stranger.sendMessage(
          create(ui.SendMessageRequestSchema, {
            threadId: strangerThread.id,
            text: "x",
            permissionMode: PermissionMode.FULL_ACCESS,
          }),
        ),
      ),
    ).toContain("not found");
    expect((await gw.api.getThread({ threadId: strangerThread.id })).thread?.permissionMode).toBe(PermissionMode.ASK);

    // Forked: Full auto until the user picks Full access again.
    const fork = (await gw.api.createThread({ forkThreadId: thread.id, forkAtTurnId: once!.id })).thread!;
    expect(fork.permissionMode).toBe(PermissionMode.FULL_AUTO);
  });

  test("a worker without full_access gets a readable refusal, never another mode", async () => {
    const asked = {
      projectId,
      workspaceId: oldWorkspace,
      title: "Old worker",
      provider: Provider.CODEX,
    };

    expect(await failure(gw.api.createThread({ ...asked, permissionMode: PermissionMode.FULL_ACCESS }))).toContain(
      REFUSED,
    );

    const thread = (await gw.api.createThread({ ...asked, permissionMode: PermissionMode.ASK })).thread!;
    expect(
      await failure(gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.FULL_ACCESS })),
    ).toContain(REFUSED);
    expect(
      await failure(gw.api.sendMessage({ threadId: thread.id, text: "x", permissionMode: PermissionMode.FULL_ACCESS })),
    ).toContain(REFUSED);

    // A default that reached the thread anyway (e.g. set while the worker was offline): the turn fails readably.
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE threads SET settings = settings || '{"permissionMode":"FULL_ACCESS"}'::jsonb WHERE id = ${thread.id}::uuid`;
      }),
    );
    await gw.api.sendMessage({ threadId: thread.id, text: "go", clientRequestId: "old-worker-go" });
    const [failed] = await settled(thread.id, 1);
    expect([failed!.status, failed!.permission_mode]).toEqual(["failed", "FULL_ACCESS"]);
    expect([failed!.error_code, failed!.error?.startsWith(REFUSED)]).toEqual(["FULL_ACCESS_UNSUPPORTED", true]);
    expect(gw.worker.turnModes.has(failed!.id)).toBe(false);
  });

  test("subagents inherit Full access; changing the parent affects only new children", async () => {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Orchestrator",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.FULL_ACCESS,
        initialMessage: "plan",
        clientRequestId: "full-access-orchestrator",
      })
    ).thread!;

    await settled(thread.id, 1);
    modern.holdTurns = true;
    const sent = await gw.api.sendMessage({ threadId: thread.id, text: "delegate", clientRequestId: "delegate" });
    await eventually(
      () => turns(thread.id),
      (t) => t.some((x) => x.id === sent.turn!.id && x.status === "running"),
    );

    // No model parameter: inherit the owner's effective mode.
    const child = json(
      await modern.callTool({
        threadId: thread.id,
        turnId: sent.turn!.id,
        tool: "spawn_thread",
        args: { title: "Child", prompt: "y", notify: false },
      }),
    );

    expect(child.permission_mode).toBe("full_access");
    const childSpec = (await modern.createdThread(child.thread_id))!;
    expect(childSpec.permissionMode).toBe(PermissionMode.FULL_ACCESS);
    nativeChildMode(childSpec.permissionMode);

    await gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.READ_ONLY });

    const readonly = json(
      await modern.callTool({
        threadId: thread.id,
        turnId: sent.turn!.id,
        tool: "spawn_thread",
        args: { title: "Read only child", prompt: "Inspect", notify: false },
      }),
    );

    expect(readonly.permission_mode).toBe("read_only");
    const readonlySpec = (await modern.createdThread(readonly.thread_id))!;
    expect(readonlySpec.permissionMode).toBe(PermissionMode.READ_ONLY);
    nativeChildMode(readonlySpec.permissionMode);
    expect((await gw.api.getThread({ threadId: child.thread_id })).thread?.permissionMode).toBe(
      PermissionMode.FULL_ACCESS,
    );

    // Legacy parameters cannot raise the parent's current ceiling.
    const asked = await modern.callTool({
      threadId: thread.id,
      turnId: sent.turn!.id,
      tool: "spawn_thread",
      args: { title: "x", prompt: "y", permission_mode: "full_access" },
    });

    expect(asked.isError).toBe(true);

    modern.holdTurns = false;
    modern.finish(thread.id, sent.turn!.id);
    await settled(thread.id, 2);
    await modern.callTool({ threadId: thread.id, tool: "close_thread", args: { thread_id: child.thread_id } });
    await modern.callTool({ threadId: thread.id, tool: "close_thread", args: { thread_id: readonly.thread_id } });
  });

  test("owner subagent settings narrow access; parent and computer ceilings are visible; parents are owner-scoped", async () => {
    const parent = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Configured parent",
        permissionMode: PermissionMode.FULL_ACCESS,
      })
    ).thread!;

    const settings = (await gw.api.getSettings({})).user!;
    const defaults = create(ui.ThreadDefaultsSchema, settings.threadDefaults);

    const setMode = async (subagentPermissionMode: PermissionMode) => {
      const user = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({
        expectedVersion: user.version,
        threadDefaults: create(ui.ThreadDefaultsSchema, { ...defaults, subagentPermissionMode }),
      });
    };

    const spawn = async (threadId = parent.id, worker = modern) => {
      const result = await worker.callTool({
        threadId,
        tool: "spawn_thread",
        args: { title: "Configured child", prompt: "Inspect", notify: false },
      });

      expect(result.isError).toBe(false);

      return (await gw.api.getThread({ threadId: json(result).thread_id })).thread!;
    };

    try {
      await setMode(PermissionMode.READ_ONLY);
      expect((await spawn()).permissionMode).toBe(PermissionMode.READ_ONLY);
      await setMode(PermissionMode.FULL_ACCESS);
      await gw.api.updateThread({ threadId: parent.id, permissionMode: PermissionMode.ASK });
      const capped = await spawn();
      expect(capped.permissionMode).toBe(PermissionMode.ASK);
      expect(capped.permissionModeNote).toContain("parent’s mode");

      const legacy = (
        await gw.api.createThread({
          projectId,
          workspaceId: oldWorkspace,
          provider: Provider.CODEX,
          title: "Local ceiling",
          permissionMode: PermissionMode.FULL_AUTO,
        })
      ).thread!;

      // A previously allowed parent, now on a computer which forbids bypass.
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE threads SET settings = settings || '{"permissionMode":"FULL_ACCESS"}'::jsonb WHERE id=${legacy.id}::uuid`;
        }),
      );
      const clamped = await spawn(legacy.id, gw.worker);
      expect(clamped.permissionMode).toBe(PermissionMode.FULL_AUTO);
      expect(clamped.permissionModeNote).toContain("on this computer");

      const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("parent-other@test", "Other")));
      const foreign = new GatewayCore({ runtime: gw.runtime, instanceId: "foreign-parent", userId: other });

      const refused = await foreign.bus.handle(
        create(AgentToolCallSchema, {
          callId: Bun.randomUUIDv7(),
          threadId: parent.id,
          toolName: "spawn_thread",
          argumentsJson: JSON.stringify({ title: "Foreign child", prompt: "x" }),
        }),
      );

      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("not found");
    } finally {
      const user = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({ expectedVersion: user.version, threadDefaults: settings.threadDefaults });
    }
  });

  test("scheduled threads retain the sandbox ceiling with a recorded explanation", async () => {
    const schedule = (
      await gw.api.createSchedule({
        target: "new_thread",
        prompt: "Clean up",
        name: "Nightly",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
        newThread: {
          projectId,
          placement: "specific",
          workspaceId,
          provider: Provider.CODEX,
          permissionMode: PermissionMode.FULL_ACCESS,
          title: "Scheduled",
        },
      })
    ).schedule!;

    expect(schedule.newThread?.permissionMode).toBe(PermissionMode.FULL_AUTO);
    expect(schedule.newThread?.permissionModeNote).toContain("Scheduled threads limit Full access");
  });
});
