import { describe, expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { CliInstallMethod, CliInstallStatusSchema, Provider, ui } from "@canopy/contracts";
import { UpdateCenter } from "../../apps/gateway/src/updates/center.ts";

/** ACKs return immediately; only a later report changes the installed version or install status. */
function fleet(workers = 1, providers = [Provider.CLAUDE], lostAck = false) {
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
      cliTools: providers.map((provider) => ({
        tool: {
          provider,
          version: "1.0.0",
          installable: true,
          method: CliInstallMethod.NATIVE,
          installResource: `tool:${provider}`,
        },
        latest: { version: "2.0.0" },
        updateAvailable: true,
        action: "update",
      })),
    })),
  });

  let stored: ui.UpdateRun | undefined;
  const commands: ui.InstallCliRequest[] = [];
  const reservations: ui.UpdateStep[] = [];

  const recreate = () =>
    new UpdateCenter({
      read: async () => stored && clone(ui.UpdateRunSchema, stored),
      write: async (run) => {
        stored = clone(ui.UpdateRunSchema, run);
      },
      snapshot: async () => clone(ui.UpdatesSnapshotSchema, snapshot),
      install: async (request) => {
        const step = stored?.steps.find(
          (item) => item.workerId === request.workerId && item.provider === request.provider,
        );

        if (!step) throw new Error("Install dispatched without a durable step");
        reservations.push(clone(ui.UpdateStepSchema, step));
        commands.push(clone(ui.InstallCliRequestSchema, request));

        if (lostAck) throw new ConnectError("Connection lost after sending install", Code.Unavailable);

        return create(ui.InstallCliResponseSchema);
      },
      manage: async () => {
        throw new Error("Only CLI updates expected");
      },
      desktop: async () => {
        throw new Error("No desktop update expected");
      },
      computer: async () => {
        throw new Error("No computer update expected");
      },
    });

  const center = recreate();

  const tool = (worker = 0, provider = Provider.CLAUDE) => {
    const item = snapshot.cliWorkers[worker]?.cliTools.find((cli) => cli.tool?.provider === provider)?.tool;

    if (!item) throw new Error("Missing fixture CLI");

    return item;
  };

  const report = (request: ui.InstallCliRequest, state: string, version = "1.0.0", error = "") => {
    const cli = snapshot.cliWorkers
      .find((worker) => worker.id === request.workerId)
      ?.cliTools.find((item) => item.tool?.provider === request.provider)?.tool;

    if (!cli) throw new Error("Missing attempted CLI");
    cli.version = version;
    cli.install = create(CliInstallStatusSchema, {
      installId: request.installId,
      targetVersion: request.version,
      state,
      error,
    });
  };

  return {
    center,
    recreate,
    commands,
    reservations,
    workers: snapshot.workers,
    tool,
    report,
    run: () => stored && clone(ui.UpdateRunSchema, stored),
    age(minutes: number) {
      if (!stored) throw new Error("No durable run to age");

      for (const step of stored.steps) step.startedAt = new Date(Date.now() - minutes * 60_000).toISOString();
    },
    async tick(target = center) {
      for (let i = 0; i < 3; i++) await target.tick();
    },
  };
}

describe("durable CLI attempts with immediate command acknowledgement and delayed reports", () => {
  test("stale failure after ACK cannot fail a new attempt; its identity was durable before dispatch", async () => {
    const f = fleet();
    f.tool().install = create(CliInstallStatusSchema, {
      installId: crypto.randomUUID(),
      targetVersion: "2.0.0",
      state: "failed",
      error: "Failure from an earlier attempt",
    });
    await f.center.begin();
    await f.tick();
    expect(f.commands).toHaveLength(1);
    const command = f.commands[0]!;
    expect(command.installId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    expect(f.reservations[0]?.requestId).toBe(command.installId);
    expect(f.reservations[0]?.state).toBe("running");
    expect(f.run()?.steps[0]?.requestId).toBe(command.installId);
    expect(f.run()?.state).toBe("running");
    f.report(command, "running");
    await f.tick();
    expect(f.run()?.steps[0]?.state).toBe("running");
    f.report(command, "succeeded", "2.0.0");
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("a matching failure affects only its step while another worker keeps installing", async () => {
    const f = fleet(2);
    await f.center.begin();
    await f.tick();
    const [failed, other] = f.commands;
    expect(f.commands).toHaveLength(2);
    f.report(failed!, "failed", "1.0.0", "Installer verification failed");
    f.report(other!, "running");
    await f.tick();
    expect(f.run()?.steps.map((step) => step.state)).toEqual(["failed", "running"]);
    expect(f.run()?.steps[0]?.reason).toBe("Installer verification failed");
    expect(f.run()?.state).toBe("running");
    f.report(other!, "succeeded", "2.0.0");
    await f.tick();
    expect(f.run()?.steps.map((step) => step.state)).toEqual(["failed", "succeeded"]);
    expect(f.run()?.state).toBe("failed");
  });

  test("a matching installer reporting the target during validation can still roll back and fail", async () => {
    const f = fleet();
    await f.center.begin();
    await f.tick();
    const command = f.commands[0]!;
    f.report(command, "running", "2.0.0");
    await f.tick();
    expect(f.run()?.state).toBe("running");
    expect(f.run()?.steps[0]?.state).toBe("running");
    expect(f.run()?.steps[0]?.finishedAt).toBe("");
    f.report(command, "failed", "1.0.0", "Validation failed; previous version restored");
    await f.tick();
    expect(f.run()?.state).toBe("failed");
    expect(f.run()?.steps[0]?.reason).toBe("Validation failed; previous version restored");
    expect(f.commands).toHaveLength(1);
  });

  test("an incompatible worker blocks its CLI promptly before dispatch with the protocol reason", async () => {
    const f = fleet();
    f.workers[0]!.compatibility = "incompatible";
    await f.center.begin();
    await f.tick();
    expect(f.commands).toHaveLength(0);
    // FailedPrecondition becomes blocked; an uncertain transport failure would remain running.
    expect(f.run()?.state).toBe("blocked");
    expect(f.run()?.steps[0]?.state).toBe("blocked");
    expect(f.run()?.steps[0]?.reason).toBe("Worker and gateway protocols are incompatible; update the worker first");
    expect(f.run()?.steps[0]?.finishedAt).not.toBe("");
  });

  test("accepted installs without reports survive 60 seconds but retain the overall completion limit", async () => {
    const f = fleet();
    await f.center.begin();
    await f.tick();
    f.age(2);
    await f.tick();
    expect(f.run()?.state).toBe("running");
    expect(f.commands).toHaveLength(1);
    f.age(36);
    await f.tick();
    expect(f.run()?.state).toBe("failed");
    expect(f.run()?.steps[0]?.reason).toContain("Timed out");
  });

  test("a lost transport ACK waits for matching running and successful reports", async () => {
    const f = fleet(1, [Provider.CLAUDE], true);
    await f.center.begin();
    await f.tick();
    expect(f.run()?.state).toBe("running");
    const command = f.commands[0]!;
    f.report(command, "running");
    f.age(2);
    await f.tick();
    expect(f.run()?.state).toBe("running");
    f.report(command, "succeeded", "2.0.0");
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
    expect(f.commands).toHaveLength(1);
  });

  test("recreation preserves the attempt identity and never replays an accepted installation", async () => {
    const f = fleet();
    await f.center.begin();
    await f.tick();
    const command = f.commands[0]!;
    const runId = f.run()!.id;
    f.age(2);
    const resumed = f.recreate();
    await f.tick(resumed);
    expect(f.run()?.state).toBe("running");
    expect(f.run()?.steps[0]?.requestId).toBe(command.installId);
    f.report(command, "running");
    await f.tick(resumed);
    f.report(command, "succeeded", "2.0.0");
    await f.tick(resumed);
    expect(f.run()?.id).toBe(runId);
    expect(f.run()?.state).toBe("succeeded");
    expect(f.commands).toHaveLength(1);
  });

  test("an already running manual installation of the same target is adopted without dispatch", async () => {
    const f = fleet();
    const manualId = crypto.randomUUID();
    f.tool().install = create(CliInstallStatusSchema, {
      installId: manualId,
      targetVersion: "2.0.0",
      state: "running",
    });
    await f.center.begin();
    await f.tick();
    expect(f.commands).toHaveLength(0);
    expect(f.run()?.steps[0]?.requestId).toBe(manualId);
    expect(f.run()?.state).toBe("running");
    f.age(2);
    const resumed = f.recreate();
    await f.tick(resumed);
    expect(f.run()?.state).toBe("running");
    f.tool().version = "2.0.0";
    f.tool().install!.state = "succeeded";
    await f.tick(resumed);
    expect(f.run()?.state).toBe("succeeded");
    expect(f.commands).toHaveLength(0);
  });

  test("a different target already installing is awaited, then the planned target is dispatched", async () => {
    const f = fleet();
    const manualId = crypto.randomUUID();
    f.tool().install = create(CliInstallStatusSchema, {
      installId: manualId,
      targetVersion: "1.5.0",
      state: "running",
    });
    await f.center.begin();
    await f.tick();
    expect(f.commands).toHaveLength(0);
    expect(f.run()?.state).toBe("running");
    expect(f.run()?.steps[0]?.requestId).not.toBe(manualId);
    f.tool().version = "1.5.0";
    f.tool().install!.state = "succeeded";
    await f.tick();
    expect(f.run()?.state).toBe("running");
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.version).toBe("2.0.0");
    f.report(f.commands[0]!, "succeeded", "2.0.0");
    await f.tick();
    expect(f.run()?.state).toBe("succeeded");
  });

  test("waiting for a different manual target keeps its 35 minute bound across recreation", async () => {
    const f = fleet();
    f.tool().install = create(CliInstallStatusSchema, {
      installId: crypto.randomUUID(),
      targetVersion: "1.5.0",
      state: "running",
    });
    await f.center.begin();
    await f.tick();
    expect(f.run()?.steps[0]?.state).toBe("queued");
    expect(Date.parse(f.run()!.steps[0]!.startedAt)).toBeGreaterThan(0);
    f.age(34);
    const waitingSince = f.run()!.steps[0]!.startedAt;
    const resumed = f.recreate();
    await f.tick(resumed);
    expect(f.run()?.state).toBe("running");
    expect(f.run()?.steps[0]?.state).toBe("queued");
    expect(f.run()?.steps[0]?.startedAt).toBe(waitingSince);
    f.age(36);
    await f.tick(resumed);
    expect(f.run()?.state).toBe("failed");
    expect(f.run()?.steps[0]?.state).toBe("failed");
    expect(f.run()?.steps[0]?.reason).toContain("Timed out waiting for another CLI installation");
    expect(f.commands).toHaveLength(0);
  });

  for (const version of ["2.0.0", "2.1.0"]) {
    test(`a stopped failed run reconciles a manual installation of ${version}`, async () => {
      const f = fleet();
      await f.center.begin();
      await f.tick();
      f.report(f.commands[0]!, "failed", "1.0.0", "Previous installation failed");
      await f.tick();
      expect(f.run()?.state).toBe("failed");
      const runId = f.run()!.id;
      f.tool().version = version;
      // A late failure from the old attempt must not override the observed current version.
      const resumed = f.recreate();
      expect((await resumed.status())?.state).toBe("succeeded");
      expect(f.run()?.id).toBe(runId);
      expect(f.run()?.steps[0]?.reason).toBe("");
      expect(f.run()?.reason).toBe("");
      expect(f.commands).toHaveLength(1);
    });
  }

  test("current target truth wins over running or failed status from another attempt", async () => {
    for (const state of ["running", "failed"]) {
      const f = fleet();
      await f.center.begin();
      await f.tick();
      f.tool().version = "2.0.0";
      f.tool().install = create(CliInstallStatusSchema, {
        installId: crypto.randomUUID(),
        targetVersion: "1.5.0",
        state,
        error: "Stale installer error",
      });
      await f.tick();
      expect(f.run()?.state).toBe("succeeded");
    }
  });

  test("ACKs release no slots: different workers overlap until delayed reports complete their attempts", async () => {
    const f = fleet(3, [Provider.CLAUDE, Provider.CODEX]);
    await f.center.begin();
    await f.tick();
    expect(f.commands).toHaveLength(4);
    expect(new Set(f.commands.map((command) => command.workerId)).size).toBe(2);
    expect(f.run()?.steps.filter((step) => step.state === "running")).toHaveLength(4);
    expect(f.run()?.steps.filter((step) => step.state === "queued")).toHaveLength(2);
    f.report(f.commands[0]!, "succeeded", "2.0.0");
    await f.tick();
    expect(f.commands).toHaveLength(5);
    expect(new Set(f.commands.map((command) => command.workerId)).size).toBe(3);

    for (const command of f.commands) f.report(command, "succeeded", "2.0.0");
    await f.tick();

    for (const command of f.commands) f.report(command, "succeeded", "2.0.0");
    await f.tick();
    expect(f.commands).toHaveLength(6);
    expect(new Set(f.commands.map((command) => command.installId)).size).toBe(6);
    expect(f.run()?.state).toBe("succeeded");
  });
});
