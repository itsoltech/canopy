import { describe, expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { CliInstallMethod, CliInstallStatusSchema, Provider, ui } from "@canopy/contracts";
import { UpdateCenter } from "../../apps/gateway/src/updates/center.ts";

/** Gates keep fake installs in flight until the test explicitly reports their result. No real installs or timers. */
function fleet(workers = 3, shared = false) {
  const snapshot = create(ui.UpdatesSnapshotSchema, {
    gatewayVersion: "2.0.0",
    workers: Array.from({ length: workers }, (_, index) => ({
      workerId: `worker-${index}`,
      name: `Worker ${index}`,
      version: "2.0.0",
      connected: true,
      compatibility: "compatible",
      installKind: "binary",
    })),
    cliWorkers: Array.from({ length: workers }, (_, index) => ({
      id: `worker-${index}`,
      name: `Worker ${index}`,
      cliTools: [Provider.CLAUDE, Provider.CODEX].map((provider) => ({
        tool: {
          provider,
          version: "1.0.0",
          installable: true,
          method: shared ? CliInstallMethod.NPM : CliInstallMethod.NATIVE,
          installResource: shared ? "prefix:/fixture/global" : "",
        },
        latest: { version: "2.0.0" },
        updateAvailable: true,
        action: "update",
      })),
    })),
  });

  let stored: ui.UpdateRun | undefined;
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const key = (worker: string, provider: Provider) => `${worker}/${provider}`;

  const center = new UpdateCenter({
    read: async () => stored && clone(ui.UpdateRunSchema, stored),
    write: async (run) => {
      stored = clone(ui.UpdateRunSchema, run);
    },
    snapshot: async () => clone(ui.UpdatesSnapshotSchema, snapshot),
    install: async (request) => {
      const id = key(request.workerId, request.provider);
      const gate = Promise.withResolvers<void>();
      gates.set(id, gate);
      started.push(id);
      await gate.promise;

      return create(ui.InstallCliResponseSchema);
    },
    manage: async (request) => {
      started.push(request.action);

      return snapshot;
    },
    desktop: async () => "desktop-request",
    computer: async (nodeId) => {
      started.push(nodeId);

      return nodeId;
    },
    app: async () => {
      started.push("self");

      return "self-request";
    },
  });

  const finish = (id: string, failed = false) => {
    const [workerId, provider] = id.split("/");

    const cli = snapshot.cliWorkers
      .find((worker) => worker.id === workerId)
      ?.cliTools.find((item) => String(item.tool?.provider) === provider)?.tool;

    if (!cli) throw new Error(`Missing fake CLI ${id}`);
    cli.version = failed ? "1.0.0" : "2.0.0";

    if (failed) cli.install = create(CliInstallStatusSchema, { state: "failed", error: "Fixture install failed" });
    gates.get(id)?.resolve();
  };

  return {
    center,
    snapshot,
    started,
    gates,
    finish,
    run: () => stored,
    async tick() {
      for (let i = 0; i < 3; i++) await center.tick();
    },
  };
}

describe("durable update scheduler with gated fake workers", () => {
  test("a local gateway drains independent peers before restart, then resumes protocol-dependent workers", async () => {
    const f = fleet(1);
    f.snapshot.gatewayInstallKind = "binary";
    f.snapshot.gatewayVersion = "1.0.0";
    f.snapshot.availableVersion = "2.0.0";
    f.snapshot.workers[0]!.version = "1.0.0";
    f.snapshot.computers.push(
      create(ui.ComputerUpdateSchema, {
        nodeId: "peer",
        name: "Peer",
        presence: "connected",
        remoteUpdate: true,
        updates: { gatewayVersion: "2.0.0", app: { connected: true, version: "1.0.0", availableVersion: "2.0.0" } },
      }),
    );
    await f.center.begin();
    await f.tick();
    expect(f.started).toEqual(["peer"]);
    f.snapshot.computers[0]!.updates!.app!.version = "2.0.0";
    await f.tick();
    expect(f.started).toEqual(["peer", "gateway"]);
    f.snapshot.gatewayVersion = "2.0.0";
    await f.tick();
    expect(f.started).toEqual(["peer", "gateway", "worker"]);
    f.snapshot.workers[0]!.version = "2.0.0";
    await f.tick();
    expect(f.started.slice(-2)).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);

    for (const id of f.started.slice(-2)) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a timed-out acknowledgement keeps its resource reserved without blocking independent targets", async () => {
    const f = fleet(3, true);
    await f.center.begin();
    await f.tick();
    f.run()!.steps[0]!.startedAt = new Date(Date.now() - 36 * 60_000).toISOString();
    await f.tick();
    expect(f.run()?.steps[0]?.state).toBe("failed");
    expect(f.started).not.toContain(`worker-0/${Provider.CODEX}`);
    f.finish(`worker-1/${Provider.CLAUDE}`);
    await f.tick();
    expect(f.started).toContain(`worker-1/${Provider.CODEX}`);
    f.finish(`worker-0/${Provider.CLAUDE}`);
    await f.tick();
    expect(f.started).toContain(`worker-0/${Provider.CODEX}`);

    for (const id of f.started) f.finish(id);
    await f.tick();

    for (const id of f.started) f.finish(id);
    await f.tick();
  });

  test("wall time for four fake workers × two CLIs, each taking 25 ms", async () => {
    const serialStart = performance.now();

    for (let i = 0; i < 8; i++) await Bun.sleep(25);
    const serial = performance.now() - serialStart;
    const f = fleet(4);
    const parallelStart = performance.now();
    await f.center.begin();
    await f.tick();

    for (let round = 0; round < 2; round++) {
      await Bun.sleep(25);

      for (const id of f.started) f.finish(id);
      await f.tick();
    }

    expect(f.run()?.state).toBe("succeeded");
    expect(f.started).toHaveLength(8);
    console.info(
      `Fake fleet 4 × 2 CLIs @25ms: sequential ${serial.toFixed(1)}ms; concurrent ${(performance.now() - parallelStart).toFixed(1)}ms`,
    );
  });

  test("different tools overlap on one worker and across workers, with four global slots", async () => {
    const f = fleet();
    await f.center.begin();
    await f.tick();
    expect(f.started).toHaveLength(4);
    expect(f.started.slice(0, 2)).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);
    expect(f.run()?.steps.filter((step) => step.state === "running")).toHaveLength(4);
    expect(f.run()?.steps.filter((step) => step.state === "queued")).toHaveLength(2);
    f.finish(f.started[0]!);
    await f.tick();
    expect(f.started).toHaveLength(5);
    expect(f.run()?.steps.filter((step) => step.state === "running")).toHaveLength(4);

    for (const id of f.started) f.finish(id);
    await f.tick();

    for (const id of f.started) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("shared prefixes serialize per worker while other workers progress after a failure", async () => {
    const f = fleet(3, true);
    await f.center.begin();
    await f.tick();
    expect(f.started).toEqual([0, 1, 2].map((i) => `worker-${i}/${Provider.CLAUDE}`));
    f.finish(f.started[0]!, true);
    await f.tick();
    expect(f.started.at(-1)).toBe(`worker-0/${Provider.CODEX}`);
    expect(f.run()?.steps[0]?.state).toBe("failed");

    for (const id of f.started.slice(1)) f.finish(id);
    await f.tick();

    for (const id of f.started.slice(1)) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("failed");
    expect(f.run()?.steps.filter((step) => step.state === "succeeded")).toHaveLength(5);
  });

  test("independent prefixes overlap and this app starts only after every in-flight update finishes", async () => {
    const f = fleet(1, true);
    f.snapshot.cliWorkers[0]!.cliTools[1]!.tool!.installResource = "prefix:/fixture/other";
    f.snapshot.gatewayBundled = true;
    f.snapshot.appUpdateSupported = true;
    f.snapshot.app = create(ui.DesktopUpdateStateSchema, {
      connected: true,
      version: "1.0.0",
      availableVersion: "2.0.0",
    });
    await f.center.begin(true);
    await f.tick();
    expect(f.started).toHaveLength(2);
    expect(f.started).not.toContain("self");
    f.finish(f.started[0]!);
    await f.tick();
    expect(f.started).not.toContain("self");
    f.finish(f.started[1]!);
    await f.tick();
    expect(f.started.at(-1)).toBe("self");
    expect(f.run()?.steps.at(-1)?.state).toBe("running");
  });
});
