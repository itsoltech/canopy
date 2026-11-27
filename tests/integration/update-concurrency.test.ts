import { describe, expect, setSystemTime, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { UpdateCenter, type UpdateCenterOptions } from "../../apps/gateway/src/updates/center.ts";

/** Fake targets report their new versions independently of the launch acknowledgement. */
function fleet(workers = 1, automatic?: UpdateCenterOptions["automatic"]) {
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
  });

  let stored: ui.UpdateRun | undefined;
  const started: string[] = [];

  const center = new UpdateCenter({
    read: async () => stored && clone(ui.UpdateRunSchema, stored),
    write: async (run) => {
      stored = clone(ui.UpdateRunSchema, run);
    },
    snapshot: async () => clone(ui.UpdatesSnapshotSchema, snapshot),
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
    ...(automatic && { automatic }),
  });

  return {
    center,
    snapshot,
    started,
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
  test("automatic updates start Update all once, wait for a shown failure and retry only a newer target", async () => {
    const f = fleet(1, { due: async () => true, ready: () => true });
    const worker = f.snapshot.workers[0]!;
    worker.version = "1.0.0";

    expect(await f.center.automatic!.tick()).toBe(true);
    expect(f.run()?.automatic).toBe(true);
    expect(f.started).toEqual(["worker"]);
    worker.state = "failed";
    worker.reason = "Download failed";
    await f.tick();
    expect(f.run()?.state).toBe("failed");

    // The failure waits for the owner, and dismissing it does not start the same target again.
    expect(await f.center.automatic!.tick()).toBe(false);
    await f.center.dismiss(f.run()!.id);
    worker.state = "";
    worker.reason = "";
    expect(await f.center.automatic!.tick()).toBe(false);
    expect(f.started).toEqual(["worker"]);

    f.snapshot.gatewayVersion = "3.0.0";
    expect(await f.center.automatic!.tick()).toBe(true);
    expect(f.run()?.steps.map((step) => step.version)).toEqual(["3.0.0"]);
    expect(f.started).toEqual(["worker", "worker"]);
  });

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
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a failed linked app can retry after it reconnects", async () => {
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
    expect(failed.steps.map((step) => step.state)).toEqual(["failed"]);
    expect(f.started).toEqual(["peer"]);
    app.phase = "checking";
    await f.center.retry(failed.id, 0);
    await f.tick();
    expect(f.started).toEqual(["peer", "peer"]);
    app.version = "2.0.0";
    app.phase = "succeeded";
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a linked app that stays disconnected past the restart window is skipped", async () => {
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
      expect(f.run()?.state).toBe("succeeded");
    } finally {
      setSystemTime();
    }
  });

  test("four workers start together and retrying failed workers preserves successes", async () => {
    const f = fleet(5);

    for (const worker of f.snapshot.workers) worker.version = "1.0.0";
    const commands: string[] = [];
    f.center.options.manage = async (request) => {
      commands.push(request.workerId);

      return f.snapshot;
    };

    await f.center.begin();
    expect(commands).toEqual(["worker-0", "worker-1", "worker-2", "worker-3"]);
    expect(await f.center.begin()).toBeUndefined();
    f.snapshot.workers[0]!.state = "failed";
    f.snapshot.workers[1]!.state = "failed";
    f.snapshot.workers[2]!.version = "2.0.0";
    f.snapshot.workers[3]!.version = "2.0.0";
    await f.tick();
    expect(commands.at(-1)).toBe("worker-4");
    f.snapshot.workers[4]!.version = "2.0.0";
    await f.tick();
    const run = f.run()!;
    expect(run.state).toBe("failed");
    expect(run.steps.every((step) => !!step.finishedAt)).toBe(true);

    f.snapshot.workers[0]!.state = "idle";
    f.snapshot.workers[1]!.state = "idle";
    await f.center.retryFailed(run.id);
    expect(f.run()?.steps.map((step) => step.state)).toEqual([
      "running",
      "running",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(commands.slice(5)).toEqual(["worker-0", "worker-1"]);
    f.snapshot.workers[0]!.version = "2.0.0";
    f.snapshot.workers[1]!.version = "2.0.0";
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a legacy running plan resumes its Canopy worker and retires queued and running installers", async () => {
    const f = fleet();
    f.snapshot.workers[0]!.version = "1.0.0";

    const old = create(ui.UpdateRunSchema, {
      id: "before-restart",
      state: "running",
      steps: [
        { kind: "cli", state: "running", requestId: crypto.randomUUID(), workerId: "worker-0" },
        { kind: "worker", state: "queued", workerId: "worker-0", version: "2.0.0" },
        { kind: "cli", state: "queued", workerId: "worker-0" },
      ],
    });

    await f.center.options.write(old);
    await f.tick();
    expect(f.run()?.id).not.toBe(old.id);
    expect(f.run()?.steps.map((step) => [step.kind, step.state])).toEqual([["worker", "running"]]);
    expect(f.started).toEqual(["worker"]);
    f.snapshot.workers[0]!.version = "2.0.0";
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
    expect(f.started).toEqual(["worker"]);
  });

  test("a CLI-only legacy plan cannot resume after restart or block a fresh Canopy update", async () => {
    const f = fleet();
    await f.center.options.write(
      create(ui.UpdateRunSchema, {
        id: "cli-only",
        state: "running",
        steps: [{ kind: "cli", state: "queued", workerId: "worker-0" }],
      }),
    );
    await f.center.tick();
    expect(await f.center.status()).toBeUndefined();
    expect(f.run()).toMatchObject({ state: "superseded", steps: [] });
    expect(f.started).toEqual([]);
    f.snapshot.workers[0]!.version = "1.0.0";
    await f.center.begin();
    expect(f.started).toEqual(["worker"]);
  });
});
