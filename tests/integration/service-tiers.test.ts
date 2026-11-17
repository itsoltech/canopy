import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SERVICE_TIERS_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayCore } from "@canopy/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("execution speed durability and worker dispatch", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: [SERVICE_TIERS_CAPABILITY] } } });
    projectId = (await gw.api.createProject({ name: "Execution speed" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/speed" }))
      .workspace!.id;
    gw.worker.models = gw.worker.models.map((profile) => ({
      ...profile,
      models: profile.models?.map((model) => ({
        ...model,
        serviceTiers: [
          { id: "fast", name: "Fast", description: "Fast execution" },
          { id: "priority", name: "Priority", description: "Priority execution" },
          { id: "ultrafast", name: "Ultrafast", description: "Ultrafast execution" },
        ],
      })),
    }));
    await gw.api.listModels({ refresh: true });
  }, 60_000);

  afterAll(async () => gw?.close());

  const thread = (serviceTier = "fast") =>
    gw.api
      .createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        serviceTier,
        clientRequestId: crypto.randomUUID(),
      })
      .then((response) => response.thread!);

  const turns = (threadId: string) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{ id: string; status: string; service_tier: string; error_code: string | null }>`
      SELECT id,status,service_tier,error_code FROM turns WHERE thread_id=${threadId}::uuid ORDER BY ordinal`;
      }),
    );

  test("per-account catalog validates accelerated speed and preserves explicit standard reset", async () => {
    const profiles = (await gw.api.listModels({})).workers[0]!.profiles;
    expect(profiles[0]!.models[0]!.serviceTiers.map((tier) => tier.id)).toEqual(["fast", "priority", "ultrafast"]);
    expect(await failure(thread("missing-tier"))).toContain("unavailable");
    const created = await thread();
    expect(created.serviceTier).toBe("fast");
    await gw.api.sendMessage({ threadId: created.id, text: "Fast", clientRequestId: "fast" });

    const first = await eventually(
      () => turns(created.id),
      (rows) => rows[0]?.status === "completed",
    );

    expect(gw.worker.turnServiceTiers.get(first[0]!.id)).toBe("fast");
    await gw.api.sendMessage({
      threadId: created.id,
      text: "Standard",
      serviceTier: "default",
      clientRequestId: "standard",
    });

    const second = await eventually(
      () => turns(created.id),
      (rows) => rows[1]?.status === "completed",
    );

    expect(gw.worker.turnServiceTiers.get(second[1]!.id)).toBe("default");
    expect(second.map((row) => row.service_tier)).toEqual(["fast", "default"]);
    expect((await gw.api.getThread({ threadId: created.id })).thread!.serviceTier).toBe("fast");
    expect((await gw.api.updateThread({ threadId: created.id, serviceTier: "" })).thread!.serviceTier).toBe("");
    expect((await gw.api.updateThread({ threadId: created.id, serviceTier: "default" })).thread!.serviceTier).toBe(
      "default",
    );
  });

  test("steer fallback retains its tier across a gateway restart and later default changes", async () => {
    gw.worker.holdTurns = true;
    gw.worker.steerMode = "not_running";
    const created = await thread();
    await gw.api.sendMessage({ threadId: created.id, text: "Running", clientRequestId: "running" });

    const running = await eventually(
      () => turns(created.id),
      (rows) => rows[0]?.status === "running",
    );

    const response = await gw.api.sendMessage({
      threadId: created.id,
      text: "Next",
      serviceTier: "ultrafast",
      delivery: ui.MessageDelivery.STEER,
      clientRequestId: "steer",
    });

    expect(response.steer).toBeDefined();

    const queued = await eventually(
      () => turns(created.id),
      (rows) => rows[1]?.status === "queued",
    );

    expect(queued[1]!.service_tier).toBe("ultrafast");
    const fresh = new GatewayCore({ runtime: gw.runtime, instanceId: "speed-restart", userId: gw.userId });
    expect((await fresh.getThread(created.id)).serviceTier).toBe("fast");
    await gw.api.updateThread({ threadId: created.id, serviceTier: "default" });
    gw.worker.holdTurns = false;
    gw.worker.finish(created.id, running[0]!.id);

    const ended = await eventually(
      () => turns(created.id),
      (rows) => rows[1]?.status === "completed",
    );

    expect(gw.worker.turnServiceTiers.get(ended[1]!.id)).toBe("ultrafast");
    gw.worker.steerMode = "accept";
  });

  test("side threads and forks retain speed, and agent delegation inherits its active turn", async () => {
    gw.worker.holdTurns = true;
    const created = await thread();
    await gw.api.sendMessage({
      threadId: created.id,
      text: "Priority turn",
      serviceTier: "priority",
      clientRequestId: "delegate",
    });

    const active = await eventually(
      () => turns(created.id),
      (rows) => rows[0]?.status === "running",
    );

    const turnId = active[0]!.id;

    const spawned = await gw.worker.callTool({
      threadId: created.id,
      turnId,
      tool: "spawn_thread",
      args: { title: "Priority child", prompt: "Work", notify: false },
    });

    expect(spawned.isError).toBe(false);

    const children = await eventually(
      () => gw.api.listThreads({ projectId }),
      (response) => response.threads.some((item) => item.title === "Priority child"),
    );

    const child = children.threads.find((item) => item.title === "Priority child")!;
    expect(child.serviceTier).toBe("priority");

    const childTurns = await eventually(
      () => turns(child.id),
      (rows) => rows[0]?.status === "running",
    );

    expect(gw.worker.turnServiceTiers.get(childTurns[0]!.id)).toBe("priority");

    const side = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        parentThreadId: created.id,
        clientRequestId: "side-inherit",
      })
    ).thread!;

    expect(side.serviceTier).toBe("fast");
    gw.worker.models = gw.worker.models.map((profile) => ({
      ...profile,
      models: [...(profile.models ?? []), { id: "standard-only", serviceTiers: [] }],
    }));
    await gw.api.listModels({ refresh: true });

    const standardChild = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        parentThreadId: created.id,
        model: "standard-only",
        clientRequestId: "side-standard-model",
      })
    ).thread!;

    expect(standardChild.serviceTier).toBe("");
    expect(
      await failure(
        gw.api.sendMessage({
          threadId: created.id,
          text: "Explicit unsupported speed",
          model: "standard-only",
          serviceTier: "fast",
          clientRequestId: "unsupported-explicit",
        }),
      ),
    ).toContain("unavailable");

    const standardTurn = await gw.api.sendMessage({
      threadId: created.id,
      text: "Use another model",
      model: "standard-only",
      clientRequestId: "unsupported-inherited",
    });

    gw.worker.holdTurns = false;
    gw.worker.finish(child.id, childTurns[0]!.id);
    gw.worker.finish(created.id, turnId);
    await eventually(
      () => turns(created.id),
      (rows) => rows[1]?.status === "completed",
    );

    expect(gw.worker.turnServiceTiers.get(standardTurn.turn!.id)).toBe("default");

    const fork = (
      await gw.api.createThread({ forkThreadId: created.id, forkAtTurnId: turnId, clientRequestId: "speed-fork" })
    ).thread!;

    expect(fork.serviceTier).toBe("fast");
  });

  test("catalog disappearance rejects selection and fails queued accelerated work explicitly", async () => {
    gw.worker.holdTurns = true;
    const created = await thread();
    await gw.api.sendMessage({ threadId: created.id, text: "Running", clientRequestId: "run" });

    const running = await eventually(
      () => turns(created.id),
      (rows) => rows[0]?.status === "running",
    );

    await gw.api.sendMessage({
      threadId: created.id,
      text: "Queued fast",
      serviceTier: "fast",
      clientRequestId: "queue",
    });
    gw.worker.models = [];
    await gw.api.listModels({ refresh: true });
    expect(await failure(thread())).toContain("unavailable");
    gw.worker.holdTurns = false;
    gw.worker.finish(created.id, running[0]!.id);

    const ended = await eventually(
      () => turns(created.id),
      (rows) => rows[1]?.status === "failed",
    );

    expect(ended[1]!.error_code).toBe("SERVICE_TIER_UNAVAILABLE");
    expect(gw.worker.turnServiceTiers.has(ended[1]!.id)).toBe(false);
    expect((await thread("default")).serviceTier).toBe("default");
  });
});
