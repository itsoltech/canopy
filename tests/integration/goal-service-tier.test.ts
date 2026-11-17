import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { SERVICE_TIERS_CAPABILITY } from "@canopy/domain/release/protocol";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("Claude goal rejected before worker dispatch", () => {
  let gw: TestGateway;
  let worker: ScriptedWorker;
  let workspaceId: string;
  let projectId: string;
  let workerId: string;

  beforeAll(async () => {
    gw = await startTestGateway();
    const claude = await gw.addWorker("Goal speed", ["/studio"]);
    workerId = claude.workerId;
    worker = await gw.connect(workerId, claude.credential, undefined, {
      claude: true,
      hello: { capabilities: [SERVICE_TIERS_CAPABILITY] },
      models: [
        {
          provider: Provider.CLAUDE,
          profileId: "native",
          models: [
            {
              id: "opus",
              isDefault: true,
              serviceTiers: [{ id: "fast", name: "Fast" }],
            },
          ],
        },
      ],
    });
    projectId = (await gw.api.createProject({ name: "Goal speed" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: "/studio/goals" })).workspace!.id;
    await gw.api.listModels({ workerId, refresh: true });
  }, 60_000);

  afterAll(async () => gw?.close());

  async function catalog(fast: boolean) {
    worker.models = [
      {
        provider: Provider.CLAUDE,
        profileId: "native",
        models: [
          {
            id: "opus",
            isDefault: true,
            serviceTiers: fast ? [{ id: "fast", name: "Fast" }] : [],
          },
        ],
      },
    ];
    await gw.api.listModels({ workerId, refresh: true });
  }

  test("lost Fast entitlement records the queued goal error and publishes it without starting /goal", async () => {
    worker.holdTurns = true;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CLAUDE,
        model: "opus",
        serviceTier: "fast",
      })
    ).thread!;

    const running = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Finish current work", clientRequestId: "running" })
    ).turn!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (response) => response.thread?.status === "running",
    );
    const set = (await gw.api.setGoal({ threadId: thread.id, action: "set", objective: "Ship the fix" })).goal!;

    const before = await watchUntil(gw.api, thread.id, (updates) =>
      updates.some((update) => update.change.case === "snapshot"),
    );

    const queued = before
      .flatMap((update) => (update.change.case === "snapshot" ? update.change.value.turns : []))
      .find((turn) => turn.goalId === set.id)!;

    expect(queued.status).toBe("queued");
    await catalog(false);

    const live = await watchUntil(
      gw.api,
      thread.id,
      (updates) =>
        updates.some(
          (update) => update.change.case === "goal" && update.change.value.error.includes("SERVICE_TIER_UNAVAILABLE"),
        ),
      (update) => {
        if (update.change.case === "snapshot") worker.finish(thread.id, running.id);
      },
    );

    const changed = live
      .flatMap((update) => (update.change.case === "goal" ? [update.change.value] : []))
      .find((goal) => goal.error.includes("SERVICE_TIER_UNAVAILABLE"));

    expect(changed).toMatchObject({ id: set.id, status: "active" });
    expect(changed?.errorAt).toBeDefined();
    expect(changed?.error).toContain('Execution speed "fast" is unavailable');

    const snapshotUpdates = await watchUntil(gw.api, thread.id, (updates) =>
      updates.some((update) => update.change.case === "snapshot"),
    );

    const snapshot = snapshotUpdates.flatMap((update) =>
      update.change.case === "snapshot" ? [update.change.value] : [],
    )[0]!;

    expect(snapshot.goal).toMatchObject({
      id: set.id,
      error: changed!.error,
      errorAt: changed!.errorAt,
      status: "active",
    });
    expect(snapshot.turns.find((turn) => turn.id === queued.id)).toMatchObject({
      status: "failed",
      errorCode: "SERVICE_TIER_UNAVAILABLE",
    });
    expect(worker.commands.some((command) => command.case === "startTurn" && command.value.turnId === queued.id)).toBe(
      false,
    );
  });

  test("an immediately rejected goal returns its persisted error instead of publishing stale empty state", async () => {
    await catalog(true);

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CLAUDE,
        model: "opus",
        serviceTier: "fast",
      })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (response) => response.thread?.status === "idle",
    );
    await catalog(false);
    const set = (await gw.api.setGoal({ threadId: thread.id, action: "set", objective: "Run the new goal" })).goal!;
    expect(set.error).toContain("SERVICE_TIER_UNAVAILABLE");
    expect(set.errorAt).toBeDefined();
    expect(set.status).toBe("active");
    expect(
      worker.commands.some((command) => command.case === "startTurn" && command.value.thread?.threadId === thread.id),
    ).toBe(false);
  });
});
