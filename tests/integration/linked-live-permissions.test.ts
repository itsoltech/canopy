import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { CLAUDE_LIVE_PERMISSIONS_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import * as permissionState from "../../apps/gateway/src/core/turn-permission-state.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("live permissions when spawning across linked computers", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("Parent computer");
    b = await configComputer("Child computer");
    await pairConfig(a, b);
    expect(await eventually(async () => a.links.reachable().includes(b.node), Boolean)).toBe(true);
  }, 60_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
  }, 30_000);

  test("a remote child waits for a held downgrade and inherits the committed mode", async () => {
    const edge = await a.gateway.addWorker("Claude parent worker");

    const worker = await a.gateway.connect(edge.workerId, edge.credential, undefined, {
      claude: true,
      models: [{ provider: Provider.CLAUDE, profileId: "native", models: [{ id: "claude-test", isDefault: true }] }],
      hello: { capabilities: ["full_access", CLAUDE_LIVE_PERMISSIONS_CAPABILITY] },
    });

    worker.holdTurns = true;
    const projectA = (await a.gateway.api.createProject({ name: "Parent project" })).project!.id;

    const workspaceA = (
      await a.gateway.api.createWorkspace({ projectId: projectA, workerId: edge.workerId, rootPath: "/repo/parent" })
    ).workspace!.id;

    const projectB = (await b.gateway.api.createProject({ name: "Child project" })).project!.id;

    const workspaceB = (
      await b.gateway.api.createWorkspace({
        projectId: projectB,
        workerId: b.gateway.workerId,
        rootPath: "/repo/child",
      })
    ).workspace!.id;

    const thread = (
      await a.gateway.api.createThread({
        projectId: projectA,
        workspaceId: workspaceA,
        provider: Provider.CLAUDE,
        permissionMode: PermissionMode.FULL_ACCESS,
      })
    ).thread!;

    await worker.createdThread(thread.id);

    const turn = (
      await a.gateway.api.sendMessage({
        threadId: thread.id,
        text: "Read the project",
        clientRequestId: crypto.randomUUID(),
      })
    ).turn!;

    expect(
      await eventually(
        () => a.gateway.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(thread.id))),
        (active) => active?.id === turn.id,
      ),
    ).toBeDefined();
    const received = Promise.withResolvers<void>();
    let complete = () => {};

    worker.handlers.set("updateTurnPermissions", (command, reply) => {
      if (!("threadId" in command && "turnId" in command && "permissionMode" in command))
        throw new Error("Expected permission update");
      complete = () => {
        worker.emit(command.threadId, command.turnId, {
          case: "turnPermissionsChanged",
          value: { permissionMode: command.permissionMode },
        });
        reply(true);
      };

      received.resolve();
    });

    const switching = a.gateway.api.updateTurnPermissions({
      threadId: thread.id,
      turnId: turn.id,
      permissionMode: PermissionMode.READ_ONLY,
    });

    await received.promise;
    const entered = Promise.withResolvers<void>();
    const mutate = permissionState.withTurnPermissionMutation;

    const observing = spyOn(permissionState, "withTurnPermissionMutation").mockImplementation(
      (runtime, id, perform) => {
        if (id === thread.id) entered.resolve();

        return mutate(runtime, id, perform);
      },
    );

    const spawning = worker.callTool({
      threadId: thread.id,
      turnId: turn.id,
      tool: "spawn_thread",
      args: {
        workspace_id: qualifyId(workspaceB, b.node),
        title: "Child after downgrade",
        prompt: "Read the project",
        provider: "codex/native",
        notify: false,
      },
    });

    try {
      await entered.promise;
      expect(b.gateway.worker.created).toHaveLength(0);
      complete();
      expect((await switching).turn?.permissionMode).toBe(PermissionMode.READ_ONLY);
      const result = await spawning;
      expect(result.isError).toBe(false);
      // Admission commits before the outbox delivers the create command to the remote worker.
      expect(
        await eventually(
          async () => b.gateway.worker.created,
          (created) => created.length > 0,
        ),
      ).toContainEqual(expect.objectContaining({ permissionMode: PermissionMode.READ_ONLY }));
    } finally {
      observing.mockRestore();
      complete();
      await Promise.allSettled([switching, spawning]);
    }
  }, 30_000);
});
