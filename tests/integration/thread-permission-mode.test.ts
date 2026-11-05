/**
 * A thread's permission mode set from the composer (UpdateThread, docs/ui-api.md): stored on the thread at once, read
 * back after a reload and a gateway restart, changed only by the thread's owner, and used from the next turn (a running
 * turn keeps the mode it started with).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let projectId = "";
let workspaceId = "";

const modes = (threadId: string) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ id: string; status: string; permission_mode: string }>`
        SELECT id, status, permission_mode FROM turns WHERE thread_id = ${threadId}::uuid ORDER BY ordinal`;
    }),
  );

describe.skipIf(!dockerAvailable)("thread permission mode (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Modes" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" }))
      .workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("set on the thread: survives a reload and a gateway restart, owner only, used from the next turn", async () => {
    gw.worker.holdTurns = true;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "sticky mode",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        initialMessage: "long task",
        clientRequestId: "create-sticky-mode",
      })
    ).thread!;

    const [running] = await eventually(
      () => modes(thread.id),
      (t) => t[0]?.status === "running",
    );

    // Changed while a turn runs: stored at once, the running turn keeps its mode.
    const updated = await gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.FULL_AUTO });
    expect(updated.thread?.permissionMode).toBe(PermissionMode.FULL_AUTO);
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.permissionMode).toBe(PermissionMode.FULL_AUTO);
    expect((await gw.api.listThreads({ projectId })).threads.find((t) => t.id === thread.id)?.permissionMode).toBe(
      PermissionMode.FULL_AUTO,
    );

    // Another user can neither change it nor see the thread.
    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other-mode@test", "Other")));
    const stranger = new GatewayCore({ runtime: gw.runtime, instanceId: "mode-stranger", userId: other });
    expect(
      await failure(
        stranger.updateThread(
          create(ui.UpdateThreadRequestSchema, { threadId: thread.id, permissionMode: PermissionMode.READ_ONLY }),
        ),
      ),
    ).toContain("thread not found");
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.permissionMode).toBe(PermissionMode.FULL_AUTO);

    // A fresh gateway over the same database reads the stored mode.
    const fresh = new GatewayCore({ runtime: gw.runtime, instanceId: "mode-restart", userId: gw.userId });
    expect((await fresh.getThread(thread.id)).permissionMode).toBe(PermissionMode.FULL_AUTO);

    gw.worker.holdTurns = false;
    gw.worker.finish(thread.id, running!.id, "done");
    await gw.api.sendMessage({ threadId: thread.id, text: "next", clientRequestId: "sticky-next" });

    const all = await eventually(
      () => modes(thread.id),
      (t) => t.length === 2 && t.every((x) => x.status === "completed"),
    );

    expect(all.map((t) => t.permission_mode)).toEqual(["ASK", "FULL_AUTO"]);
    expect(gw.worker.turnModes.get(all[1]!.id)).toEqual({
      turn: PermissionMode.FULL_AUTO,
      thread: PermissionMode.FULL_AUTO,
    });
  });
});
