import { describe, expect, setSystemTime, test } from "bun:test";
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
      online: true,
      name: `Worker ${index}`,
      cliTools: [Provider.CLAUDE, Provider.CODEX].map((provider) => ({
        tool: {
          provider,
          version: "1.0.0",
          installable: true,
          method: shared ? CliInstallMethod.NPM : CliInstallMethod.NATIVE,
          installResource: shared ? "prefix:/fixture/global" : `tool:${provider}`,
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
  const attempts = new Map<string, string>();
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
      attempts.set(id, request.installId);
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

    if (failed) {
      const installId = attempts.get(id);

      if (!installId) throw new Error(`Missing installation attempt for ${id}`);
      cli.install = create(CliInstallStatusSchema, {
        installId,
        state: "failed",
        error: "Fixture install failed",
      });
    }

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

function linkedApp(snapshot: ui.UpdatesSnapshot) {
  const peer = create(ui.ComputerUpdateSchema, {
    nodeId: "peer",
    name: "Studio",
    presence: "connected",
    readState: "fresh",
    remoteUpdate: true,
    updates: { gatewayVersion: "2.0.0", app: { connected: true, version: "1.0.0", availableVersion: "2.0.0" } },
  });

  snapshot.computers.push(peer);

  return peer;
}

describe("durable update scheduler with gated fake workers", () => {
  test("desktop workers launch alongside binary workers after the gateway restarts", async () => {
    const f = fleet(1);
    f.snapshot.gatewayInstallKind = "binary";
    f.snapshot.gatewayVersion = "1.0.0";
    f.snapshot.availableVersion = "2.0.0";
    f.snapshot.workers[0]!.version = "1.0.0";
    f.snapshot.workers.push(
      ...["laptop", "workstation"].map((workerId) =>
        create(ui.WorkerUpdateSchema, {
          workerId,
          name: workerId,
          installKind: "desktop",
          desktop: { connected: true, version: "1.0.0", availableVersion: "2.0.0" },
        }),
      ),
    );
    const laptop = f.snapshot.workers[1]!.desktop!;
    const workstation = f.snapshot.workers[2]!.desktop!;
    const requested: string[] = [];
    f.center.options.desktop = async (request) => {
      requested.push(request.workerId);

      return request.workerId;
    };

    await f.center.begin();
    expect(f.started).toEqual(["gateway"]);
    expect(requested).toEqual([]);
    f.snapshot.gatewayVersion = "2.0.0";
    workstation.connected = false;
    await f.center.tick();
    expect(f.started).toEqual(["gateway", "worker"]);
    expect(requested).toEqual(["laptop"]);
    expect(f.run()?.steps.find((step) => step.workerId === "workstation")?.state).toBe("queued");

    workstation.connected = true;
    await f.center.tick();
    expect(requested).toEqual(["laptop", "workstation"]);
    expect(
      f
        .run()
        ?.steps.filter((step) => step.state === "running")
        .map((step) => step.kind),
    ).toEqual(["worker", "desktop", "desktop"]);

    f.snapshot.workers[0]!.version = "2.0.0";
    laptop.version = "2.0.0";
    workstation.version = "2.0.0";
    await f.tick();

    for (const id of f.started.slice(2)) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a desktop restart gates every CLI, including those on a different worker", async () => {
    const f = fleet(2);
    const worker = f.snapshot.workers[1]!;
    worker.installKind = "desktop";
    worker.desktop = create(ui.DesktopUpdateStateSchema, {
      connected: true,
      version: "1.0.0",
      availableVersion: "2.0.0",
    });
    await f.center.begin();
    expect(f.run()?.steps[0]).toMatchObject({ kind: "desktop", state: "running" });
    // The new app version reopens its control stream. The last delivered report may still say waiting_idle.
    worker.desktop.phase = "waiting_idle";
    worker.desktop.requestId = "desktop-request";
    worker.desktop.connected = false;
    f.snapshot.cliWorkers[1]!.online = false;
    await f.tick();
    expect(f.started).toEqual([]);
    expect(f.run()?.steps.filter((step) => step.state === "queued")).toHaveLength(4);
    worker.desktop.version = "2.0.0";
    worker.desktop.connected = true;
    await f.tick();
    expect(f.started).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);
    f.snapshot.cliWorkers[1]!.online = true;
    await f.tick();
    expect(f.started).toHaveLength(4);

    for (const id of f.started) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("older workers keep one slot and duplicate tool entries do not launch twice", async () => {
    const f = fleet(1);
    const tools = f.snapshot.cliWorkers[0]!.cliTools;
    tools.forEach((item) => {
      item.tool!.installResource = "";
    });
    tools.push(clone(ui.WorkerCliToolSchema, tools[0]!));
    await f.center.begin();
    await f.tick();
    expect(f.run()?.steps).toHaveLength(2);
    expect(f.started).toEqual([`worker-0/${Provider.CLAUDE}`]);
    f.finish(f.started[0]!);
    await f.tick();
    expect(f.started).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);
    f.finish(f.started[1]!);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a local gateway drains independent peers before restart, then resumes protocol-dependent workers", async () => {
    const f = fleet(1);
    f.snapshot.gatewayInstallKind = "binary";
    f.snapshot.gatewayVersion = "1.0.0";
    f.snapshot.availableVersion = "2.0.0";
    f.snapshot.workers[0]!.version = "1.0.0";
    const peer = linkedApp(f.snapshot);
    await f.center.begin();
    await f.tick();
    expect(f.started).toEqual(["peer"]);
    peer.updates!.app!.version = "2.0.0";
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

  test("independent CLI prefixes overlap only after this app finishes", async () => {
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
    expect(f.started).toEqual(["self"]);
    f.snapshot.app.version = "2.0.0";
    await f.tick();
    expect(f.started).toEqual(["self", `worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);

    for (const id of f.started.slice(1)) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("resuming an older CLI-first run finishes its active install before the app and holds the queued CLI", async () => {
    const f = fleet(1);
    f.snapshot.app = create(ui.DesktopUpdateStateSchema, {
      connected: true,
      version: "1.0.0",
      availableVersion: "2.0.0",
    });
    await f.center.options.write(
      create(ui.UpdateRunSchema, {
        id: "previous-run",
        state: "running",
        steps: [
          {
            kind: "cli",
            workerId: "worker-0",
            provider: Provider.CLAUDE,
            version: "2.0.0",
            state: "running",
            startedAt: new Date().toISOString(),
            requestId: crypto.randomUUID(),
          },
          { kind: "cli", workerId: "worker-0", provider: Provider.CODEX, version: "2.0.0", state: "queued" },
          { kind: "app", version: "2.0.0", state: "queued" },
        ],
      }),
    );
    await f.tick();
    expect(f.started).toEqual([]);
    f.finish(`worker-0/${Provider.CLAUDE}`);
    await f.tick();
    expect(f.started).toEqual(["self"]);
    f.snapshot.app.version = "2.0.0";
    await f.tick();
    expect(f.started).toEqual(["self", `worker-0/${Provider.CODEX}`]);
    f.finish(f.started[1]!);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a failed online linked app blocks local CLIs until retrying the app succeeds", async () => {
    const f = fleet(1);
    const peer = linkedApp(f.snapshot);
    const ack = Promise.withResolvers<string>();
    f.center.options.computer = (nodeId) => {
      f.started.push(nodeId);

      return ack.promise;
    };

    await f.center.begin();
    peer.presence = "restarting";
    await f.tick();
    expect(f.run()?.steps[0]?.state).toBe("running");
    ack.resolve("peer");
    peer.presence = "connected";
    const app = peer.updates!.app!;
    app.requestId = "peer";
    app.phase = "failed";
    app.reason = "Download failed";
    await f.tick();
    const failed = f.run()!;
    expect(failed.steps.map((step) => step.state)).toEqual(["failed", "blocked", "blocked"]);
    expect(f.started).toEqual(["peer"]);
    app.phase = "checking";
    await f.center.retry(failed.id, 0);
    await f.tick();
    expect(f.started).toEqual(["peer", "peer"]);
    app.version = "2.0.0";
    app.phase = "succeeded";
    await f.tick();
    expect(f.started.slice(2)).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);

    for (const id of f.started.slice(2)) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a failed app that goes offline during another app update lets the online CLIs proceed", async () => {
    const f = fleet(1);
    const peer = linkedApp(f.snapshot);
    f.snapshot.gatewayBundled = true;
    f.snapshot.appUpdateSupported = true;
    f.snapshot.app = create(ui.DesktopUpdateStateSchema, {
      connected: true,
      version: "1.0.0",
      availableVersion: "2.0.0",
    });
    await f.center.begin(true);
    const app = peer.updates!.app!;
    app.requestId = "peer";
    app.phase = "failed";
    app.reason = "Download failed";
    await f.tick();
    expect(f.started).toEqual(["peer", "self"]);
    expect(f.run()?.steps[0]?.state).toBe("failed");
    peer.presence = "sleeping";
    peer.readState = "unavailable";
    f.snapshot.app.version = "2.0.0";
    await f.tick();
    expect(f.started.slice(2)).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);

    for (const id of f.started.slice(2)) f.finish(id);
    await f.tick();
    expect(
      f
        .run()
        ?.steps.filter((step) => step.kind === "cli")
        .map((step) => step.state),
    ).toEqual(["succeeded", "succeeded"]);
  });

  test("a linked app that stays disconnected past the restart window releases online CLIs", async () => {
    const f = fleet(1);
    const peer = linkedApp(f.snapshot);
    await f.center.begin();
    const app = peer.updates!.app!;
    app.requestId = "peer";
    app.phase = "waiting_idle";
    app.connected = false;
    await f.tick();
    expect(f.started).toEqual(["peer"]);

    try {
      setSystemTime(new Date(Date.now() + 6 * 60_000));
      await f.tick();
      expect(f.run()?.steps[0]).toMatchObject({ kind: "computer", state: "skipped" });
      expect(f.started.slice(1)).toEqual([`worker-0/${Provider.CLAUDE}`, `worker-0/${Provider.CODEX}`]);

      for (const id of f.started.slice(1)) f.finish(id);
      await f.tick();
      expect(f.run()?.state).toBe("succeeded");
    } finally {
      setSystemTime();
    }
  });

  test("going offline skips running and queued CLIs and frees the slot before the install ACK", async () => {
    const f = fleet(5, true);
    await f.center.begin();
    expect(f.started).toEqual([0, 1, 2, 3].map((i) => `worker-${i}/${Provider.CLAUDE}`));
    f.snapshot.cliWorkers[0]!.online = false;
    await f.tick();
    const skipped = f.run()!.steps.filter((step) => step.workerId === "worker-0");
    expect(skipped.map((step) => step.state)).toEqual(["skipped", "skipped"]);
    expect(skipped.every((step) => step.reason.toLowerCase().includes("offline") && !!step.finishedAt)).toBe(true);
    expect(f.started.at(-1)).toBe(`worker-4/${Provider.CLAUDE}`);

    for (const id of f.started.slice(1)) f.finish(id);
    await f.tick();

    for (const id of f.started.slice(5)) f.finish(id);
    await f.tick();
    expect(f.started).not.toContain(`worker-0/${Provider.CODEX}`);
    expect(f.run()?.state).toBe("succeeded");
    f.finish(f.started[0]!);
    await f.tick();
    expect(f.run()!.steps.filter((step) => step.state === "skipped")).toHaveLength(2);
  });

  test("a sleeping linked computer releases its CLI attempts, while a stale worker report alone does not", async () => {
    const f = fleet(1, true);

    const peer = create(ui.ComputerUpdateSchema, {
      nodeId: "peer",
      name: "Studio",
      presence: "connected",
      readState: "fresh",
      remoteUpdate: true,
      updates: {
        gatewayVersion: "2.0.0",
        workers: f.snapshot.workers.splice(0),
        cliWorkers: f.snapshot.cliWorkers.splice(0),
      },
    });

    f.snapshot.computers.push(peer);
    await f.center.begin();
    expect(f.started).toEqual([`worker-0/${Provider.CLAUDE}`]);
    peer.readState = "stale";
    peer.updates!.cliWorkers[0]!.online = false;
    await f.tick();
    expect(f.run()?.steps.map((step) => step.state)).toEqual(["running", "queued"]);
    peer.presence = "sleeping";
    peer.readState = "unavailable";
    peer.reason = "Studio is asleep.";
    await f.tick();
    expect(f.run()?.steps.map((step) => [step.state, step.reason])).toEqual([
      ["skipped", peer.reason],
      ["skipped", peer.reason],
    ]);
    expect(f.run()?.state).toBe("succeeded");
    expect(f.started).toEqual([`worker-0/${Provider.CLAUDE}`]);
    f.gates.get(f.started[0]!)!.resolve();
  });

  test("Update all answers with its first steps already running, from the snapshot it planned with", async () => {
    const f = fleet(3);
    const planned = await f.center.begin();

    // No tick between the click and the answer: the first slots are reserved and launched before it returns.
    expect(planned?.workers).toHaveLength(3);
    expect(f.run()?.steps.filter((step) => step.state === "running")).toHaveLength(4);
    expect(f.run()?.steps.filter((step) => step.state === "queued")).toHaveLength(2);
    expect(f.started).toHaveLength(4);
    expect(await f.center.begin()).toBeUndefined();

    for (const id of f.started) f.finish(id);
    await f.tick();

    for (const id of f.started) f.finish(id);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
    expect(f.run()?.steps.every((step) => !!step.finishedAt)).toBe(true);
  });

  test("Retry failed requeues every failed step at once and keeps the successes", async () => {
    const f = fleet(2);
    await f.center.begin();
    const [a, b, c, d] = f.started;
    f.finish(a!, true);
    f.finish(b!, true);
    f.finish(c!);
    f.finish(d!);
    await f.tick();
    const run = f.run()!;
    expect(run.state).toBe("failed");
    expect(run.steps.filter((step) => step.state === "failed").every((step) => !!step.finishedAt)).toBe(true);

    await expect(f.center.retryFailed("another-run")).rejects.toThrow("Choose a failed update");

    for (const item of f.snapshot.cliWorkers.flatMap((worker) => worker.cliTools)) item.tool!.install = undefined;
    await f.center.retryFailed(run.id);

    // The answer already shows both retried steps running; the successful ones keep their history.
    const retried = f.run()!;
    expect(retried.id).toBe(run.id);
    expect(retried.steps.map((step) => step.state)).toEqual(["running", "running", "succeeded", "succeeded"]);
    expect(retried.steps.slice(0, 2).every((step) => !step.finishedAt && !step.reason)).toBe(true);
    expect(f.started.slice(4)).toEqual([a!, b!]);
    await expect(f.center.retryFailed(run.id)).rejects.toThrow("Choose a failed update");

    f.finish(a!);
    f.finish(b!);
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });
});
