import { afterEach, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { CliInstallMethod, CliToolsReportSchema, Provider, ui, update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import {
  REMOTE_APP_UPDATE,
  REMOTE_CLI_UPGRADE_ONLY,
  REMOTE_THREADS,
  CONFIG_SYNC,
  qualifyId,
} from "@canopy/domain/computers";
import { CLI_INSTALL_UPGRADE_ONLY_CAPABILITY } from "@canopy/domain/release/protocol";
import { createGrpcClientTransport } from "@canopy/transport";
import { remoteServe, sharedHost, uiHandlers } from "@canopy/gateway/api";
import { LocalDesktopControl } from "../../apps/desktop/src/local-control.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { serveComputerUpdates, refreshComputerUpdates } from "../../apps/gateway/src/updates/linked.ts";
import { createUpdateCenter } from "../../apps/gateway/src/updates/center-composition.ts";
import { UpdateRunStore } from "../../apps/gateway/src/updates/run-store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
}, 30_000);

async function gateway(storage?: NonNullable<Parameters<typeof startTestGateway>[0]>["storage"]) {
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("2.0.0") });
  cleanups.push(() => {
    registry.stop(true);
  });

  const gateway = await startTestGateway({
    ...(storage && { storage }),
    role: "desktop",
    worker: { hello: { capabilities: ["cli_install", CLI_INSTALL_UPGRADE_ONLY_CAPABILITY, "desktop_bundled"] } },
    updates: { kind: "desktop", version: "2.0.0", source: { fetch: async () => Response.json([]) } },
    cliLatest: {
      sources: { claude: `${registry.url}`, codex: `${registry.url}`, grok: `${registry.url}` },
      allowHttpForTests: true,
    },
  });

  const close = gateway.close;
  let closed = false;
  gateway.close = async (keepDatabase = false) => {
    if (closed) return;
    closed = true;
    gateway.core.updateCenter.stop();
    gateway.core.updates.close();
    await close(keepDatabase);
  };

  cleanups.push(() => gateway.close());
  const updater = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: gateway.grpcUrl }));
  await updater.check(
    {
      workerId: gateway.workerId,
      version: "2.0.0",
      installKind: "desktop",
      os: "linux",
      arch: "x64",
      minWorkerLinkProtocol: 1,
      workerLinkProtocol: 1,
    },
    { headers: { authorization: `Bearer ${gateway.workerCredential}` } },
  );

  return gateway;
}

async function linkGateways(a: TestGateway, b: TestGateway, name = "Linked computer", peerSupportsGuard = true) {
  for (const gateway of [a, b]) {
    if (gateway.core.computers) continue;

    const computers = linkedComputers({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 1000,
      core: gateway.core,
      shared: sharedHost(gateway.core, uiHandlers(gateway.core)),
      serve: remoteServe(uiHandlers(gateway.core), gateway.core),
      updates: (nodeId, method, request) => serveComputerUpdates(gateway.core, nodeId, method, request),
      capabilities: [
        "presence",
        "unlink",
        REMOTE_THREADS,
        REMOTE_APP_UPDATE,
        CONFIG_SYNC,
        ...(gateway === a || peerSupportsGuard ? [REMOTE_CLI_UPGRADE_ONLY] : []),
      ],
    });

    gateway.core.computers = computers;
    gateway.core.network = computers.options.network;
    await computers.start();
    await computers.manage(
      create(ui.ComputerOperationRequestSchema, { action: "rename", name: gateway === a ? "This computer" : name }),
    );
    cleanups.push(() => computers.close());
  }

  const invitation = await a.api.createComputerPairing({ shareConfig: true });
  await b.api.linkComputer({ address: a.core.computers!.addresses[0]!, code: invitation.code, shareConfig: true });
  const nodeId = b.core.computers!.hello().nodeId;
  expect(await eventually(async () => a.core.computers!.reachable().includes(nodeId), Boolean, 15_000)).toBe(true);

  return nodeId;
}

/** Only records commands and reports scripted versions; it never invokes an installer. */
async function fakeApp(
  gateway: TestGateway,
  label: string,
  events: string[],
  available = true,
  previous?: ui.DesktopUpdateState,
) {
  let state =
    previous ??
    create(ui.DesktopUpdateStateSchema, {
      version: "1.0.0",
      channel: "nightly",
      phase: "idle",
      ready: available,
      updaterPhase: available ? "downloaded" : "idle",
      updaterVersion: available ? "2.0.0" : "",
    });

  const requests: string[] = [];

  const control = new LocalDesktopControl(gateway.api, gateway.workerId, (command) => {
    if (!command.requestId || requests.includes(command.requestId)) return;
    requests.push(command.requestId);
    events.push(label);
    state = create(ui.DesktopUpdateStateSchema, {
      ...state,
      requestId: command.requestId,
      targetVersion: "2.0.0",
      phase: "waiting_idle",
    });
    void control.report(toJsonString(ui.DesktopUpdateStateSchema, state));
  });

  await control.report(toJsonString(ui.DesktopUpdateStateSchema, state));
  const loop = control.run();
  cleanups.push(async () => {
    control.stop();
    await loop;
  });
  expect(await eventually(async () => gateway.core.appControl.snapshot().connected, Boolean)).toBe(true);

  return {
    requests,
    get snapshot() {
      return state;
    },
    stop: async () => {
      control.stop();
      await loop;
    },
    finish: async () => {
      state = create(ui.DesktopUpdateStateSchema, {
        ...state,
        version: "2.0.0",
        phase: "succeeded",
        ready: false,
        updaterPhase: "idle",
        updaterVersion: "",
        availableVersion: "2.0.0",
      });
      await control.report(toJsonString(ui.DesktopUpdateStateSchema, state));
      expect(await eventually(async () => gateway.core.appControl.snapshot().version === "2.0.0", Boolean)).toBe(true);
    },
  };
}

async function clis(gateway: TestGateway, versions: [string, string], state = "", fail = false) {
  await gateway.core.cli.report(
    gateway.core.link.connections.get(gateway.workerId)!,
    create(CliToolsReportSchema, {
      os: "linux",
      arch: "x64",
      tools: [Provider.CLAUDE, Provider.CODEX].map((provider, index) => {
        const command = gateway.worker.commands.findLast(
          (command) => command.case === "installCli" && command.value.provider === provider,
        );

        return {
          provider,
          version: versions[index] || "",
          installable: true,
          method: index === 0 ? CliInstallMethod.NATIVE : CliInstallMethod.NPM,
          ...(state &&
            command?.case === "installCli" && {
              install: {
                installId: command.value.installId,
                state: fail && index === 0 ? "failed" : state,
                error: fail && index === 0 ? "Download failed. Retry the update." : "",
              },
            }),
        };
      }),
    }),
  );
  await gateway.core.cli.checks.tick(gateway.workerId, true);
}

async function tickUntil(gateway: TestGateway, predicate: (run: ui.UpdateRun | undefined) => boolean) {
  expect(
    await eventually(
      async () => {
        await gateway.core.updateCenter.tick();

        return predicate((await gateway.api.getUpdates({})).run);
      },
      Boolean,
      15_000,
    ),
  ).toBe(true);
}

describe.skipIf(!dockerAvailable)("Update all across linked computers with fake updaters", () => {
  test("guarded CLI installs cannot reach an older linked gateway", async () => {
    const a = await gateway();
    const b = await gateway();
    await clis(b, ["1.0.0", "2.0.0"]);
    const nodeId = await linkGateways(a, b, "Older computer", false);
    const request = { workerId: qualifyId(b.workerId, nodeId), provider: Provider.CLAUDE, version: "2.0.0" };
    expect(await failure(a.api.installCli({ ...request, upgradeOnly: true }))).toContain(
      "Update Canopy on this computer",
    );
    expect(b.worker.commands.filter((command) => command.case === "installCli")).toHaveLength(0);

    expect((await a.api.installCli(request)).started).toEqual([b.workerId]);
    expect(b.worker.commands.filter((command) => command.case === "installCli")).toHaveLength(1);
  });

  test("the authenticated linked CLI route preserves a supplied UUID in commands and reports", async () => {
    const a = await gateway();
    const b = await gateway();
    await clis(b, ["1.0.0", "2.0.0"]);
    const nodeId = await linkGateways(a, b);
    const workerId = qualifyId(b.workerId, nodeId);
    const installId = crypto.randomUUID();

    expect(
      await failure(
        a.api.installCli({
          workerId,
          provider: Provider.CLAUDE,
          version: "2.0.0",
          installId: qualifyId(installId, nodeId),
        }),
      ),
    ).toContain("install_id must be a UUID");
    expect(b.worker.commands.filter((command) => command.case === "installCli")).toHaveLength(0);

    b.worker.handlers.set("installCli", async (value, reply) => {
      if (value.$typeName !== "canopy.worker.v1.InstallCli") throw new Error("Expected CLI command");
      await clis(b, ["1.0.0", "2.0.0"], "running");
      reply(true);
    });

    const response = await a.api.installCli({
      workerId,
      provider: Provider.CLAUDE,
      version: "2.0.0",
      installId,
      upgradeOnly: true,
    });

    expect(response.started).toEqual([b.workerId]);
    expect(b.worker.commands.filter((command) => command.case === "installCli")).toMatchObject([
      { case: "installCli", value: { provider: Provider.CLAUDE, version: "2.0.0", installId, upgradeOnly: true } },
    ]);

    const report = async () => {
      refreshComputerUpdates(a.core, nodeId);
      const computer = (await a.api.getUpdates({})).computers.find((computer) => computer.nodeId === nodeId);

      return computer?.updates?.cliWorkers.find((worker) => worker.id === workerId);
    };

    const running = await eventually(report, (worker) => worker?.cliTools[0]?.tool?.install?.state === "running");
    expect(running?.nodeId).toBe(nodeId);
    expect(running?.cliTools[0]?.tool?.install?.installId).toBe(installId);
    await clis(b, ["2.0.0", "2.0.0"], "succeeded");
    const finished = await eventually(report, (worker) => worker?.cliTools[0]?.tool?.install?.state === "succeeded");
    expect(finished?.cliTools[0]?.tool).toMatchObject({
      version: "2.0.0",
      install: { installId, state: "succeeded" },
    });
    expect(a.worker.commands.filter((command) => command.case === "installCli")).toHaveLength(0);
  }, 60_000);

  test("linked apps overlap, then the local app updates before any CLI; a restart retains the same run", async () => {
    const a = await gateway();
    const b = await gateway();
    const c = await gateway();
    const events: string[] = [];
    const own = await fakeApp(a, "own app", events);
    const linked = await fakeApp(b, "linked app", events);
    const second = await fakeApp(c, "second linked app", events);
    await clis(a, ["1.0.0", "2.0.0"]);
    await clis(b, ["1.0.0", "1.0.0"]);
    const nodeId = await linkGateways(a, b);
    const secondNode = await linkGateways(a, c, "Second computer");
    expect(
      await eventually(async () => {
        const { computers } = await a.api.getUpdates({});
        const first = computers.find((computer) => computer.nodeId === nodeId)?.updates;
        const second = computers.find((computer) => computer.nodeId === secondNode)?.updates;

        return (
          first?.app?.ready && second?.app?.ready && first.cliWorkers.some((worker) => worker.cliTools.length === 2)
        );
      }, Boolean),
    ).toBe(true);

    const attempts: { installId: string; persistedId: string | undefined }[] = [];

    for (const [target, name] of [
      [a, "local"],
      [b, "linked"],
    ] as const) {
      target.worker.handlers.set("installCli", async (value, reply) => {
        if (value.$typeName !== "canopy.worker.v1.InstallCli") throw new Error("Expected CLI command");
        const run = await new UpdateRunStore(a.runtime, a.userId).read();
        const workerId = name === "local" ? a.workerId : qualifyId(b.workerId, nodeId);
        attempts.push({
          installId: value.installId,
          persistedId: run?.steps.find((step) => step.workerId === workerId && step.provider === value.provider)
            ?.requestId,
        });
        events.push(`${name} CLI ${value.provider}`);
        const codexDone = name === "local" || events.includes(`${name} CLI ${Provider.CODEX}`);
        await clis(target, ["2.0.0", codexDone ? "2.0.0" : "1.0.0"], "succeeded");
        reply(true);
      });
    }

    expect(await failure(a.api.manageUpdates({ action: "update_all" }))).toContain("Confirm the computer restart");
    const started = await a.api.manageUpdates({ action: "update_all", confirmRestart: true });
    expect(started.run?.steps.map((step) => step.kind)).toEqual(["computer", "computer", "app", "cli", "cli", "cli"]);
    const duplicate = await a.api.manageUpdates({ action: "update_all" });
    expect(duplicate.run?.id).toBe(started.run?.id);
    await tickUntil(a, () => linked.requests.length === 1 && second.requests.length === 1);
    expect(own.requests).toEqual([]);
    expect(attempts).toHaveLength(0);
    await linked.finish();
    refreshComputerUpdates(a.core, nodeId);
    await tickUntil(
      a,
      (run) => run?.steps.find((step) => step.nodeId === nodeId && step.kind === "computer")?.state === "succeeded",
    );
    expect(own.requests).toEqual([]);
    expect(attempts).toHaveLength(0);
    await second.finish();
    refreshComputerUpdates(a.core, secondNode);
    await tickUntil(a, () => own.requests.length === 1);
    expect(attempts).toHaveLength(0);
    a.core.updateCenter.stop();
    const resumed = createUpdateCenter(a.core);
    expect((await resumed.status())?.id).toBe(started.run?.id);
    await resumed.tick();
    expect(own.requests).toHaveLength(1);
    expect(attempts).toHaveLength(0);
    await own.finish();
    expect(
      await eventually(
        async () => {
          await resumed.tick();

          return (await resumed.status())?.state;
        },
        (state) => state === "succeeded",
        15_000,
      ),
    ).toBe("succeeded");
    expect(events.slice(0, 2).sort()).toEqual(["linked app", "second linked app"]);
    expect(events[2]).toBe("own app");
    expect(events.filter((event) => event.includes(" CLI ")).sort()).toEqual(
      [`local CLI ${Provider.CLAUDE}`, `linked CLI ${Provider.CLAUDE}`, `linked CLI ${Provider.CODEX}`].sort(),
    );
    expect(attempts).toHaveLength(3);

    for (const attempt of attempts) {
      expect(attempt.installId).toMatch(/^[0-9a-f-]{36}$/);
      expect(attempt.persistedId).toBe(attempt.installId);
    }

    expect(new Set(attempts.map((attempt) => attempt.installId)).size).toBe(3);
    const cliSteps = (await a.api.getUpdates({})).run?.steps.filter((step) => step.kind === "cli");
    expect(cliSteps?.map((step) => [step.nodeId, step.workerId, step.provider])).toEqual([
      ["", a.workerId, Provider.CLAUDE],
      [nodeId, qualifyId(b.workerId, nodeId), Provider.CLAUDE],
      [nodeId, qualifyId(b.workerId, nodeId), Provider.CODEX],
    ]);
    expect(cliSteps?.map((step) => step.requestId).sort()).toEqual(attempts.map((attempt) => attempt.installId).sort());
    expect(
      (await new UpdateRunStore(a.runtime, a.userId).read())?.steps.every((step) => step.state === "succeeded"),
    ).toBe(true);
  }, 90_000);

  test("a CLI failure preserves the completed linked app and other CLI on retry", async () => {
    const a = await gateway();
    const b = await gateway();
    const events: string[] = [];
    await fakeApp(a, "own app", events, false);
    const linked = await fakeApp(b, "linked app", events);
    await clis(a, ["1.0.0", "1.0.0"]);
    const nodeId = await linkGateways(a, b);
    expect(await eventually(async () => (await a.api.getUpdates({})).computers[0]?.updates?.app?.ready, Boolean)).toBe(
      true,
    );
    a.worker.handlers.set("installCli", async (value, reply) => {
      if (value.$typeName !== "canopy.worker.v1.InstallCli") throw new Error("Expected CLI command");
      const failed = value.provider === Provider.CLAUDE;
      await clis(a, ["1.0.0", failed ? "1.0.0" : "2.0.0"], "succeeded", true);
      reply(true);
    });
    const started = await a.api.manageUpdates({ action: "update_all" });
    await tickUntil(a, () => linked.requests.length === 1);
    await linked.finish();
    refreshComputerUpdates(a.core, nodeId);
    await tickUntil(a, (run) => run?.state === "failed");
    const stopped = (await a.api.getUpdates({})).run!;
    expect(stopped.steps).toMatchObject([
      { kind: "computer", state: "succeeded", reason: "" },
      { kind: "cli", state: "failed" },
      { kind: "cli", state: "succeeded" },
    ]);
    expect(stopped.steps[1]?.reason).toContain("Download failed");
    expect(
      await failure(
        a.api.manageUpdates({ action: "retry_step", desktopRequestId: crypto.randomUUID(), updateStepIndex: 1 }),
      ),
    ).toContain("current results");
    a.worker.handlers.set("installCli", async (_value, reply) => {
      await clis(a, ["2.0.0", "2.0.0"], "succeeded");
      reply(true);
    });
    await a.api.manageUpdates({ action: "retry_step", desktopRequestId: started.run?.id || "", updateStepIndex: 1 });
    await tickUntil(a, (run) => run?.state === "succeeded");
    expect(linked.requests).toHaveLength(1);
    expect((await a.api.getUpdates({})).run?.id).toBe(started.run?.id);
  }, 90_000);

  test("slow installer acknowledgements leave progress readable and a second click returns the existing run", async () => {
    const a = await gateway();
    await clis(a, ["1.0.0", "2.0.0"]);
    const waiting = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const acknowledged = Promise.withResolvers<void>();
    a.worker.handlers.set("installCli", (_value, reply) => {
      received.resolve();
      void waiting.promise
        .then(async () => {
          await clis(a, ["2.0.0", "2.0.0"], "succeeded");
          reply(true);
        })
        .then(acknowledged.resolve, acknowledged.reject);
    });
    const started = await a.api.manageUpdates({ action: "update_all" }, { timeoutMs: 3000 });
    await received.promise;

    try {
      const progress = await a.api.getUpdates({}, { timeoutMs: 3000 });
      expect(progress.run?.steps[0]?.state).toBe("running");
      const duplicate = await a.api.manageUpdates({ action: "update_all" }, { timeoutMs: 3000 });
      expect(duplicate.run?.id).toBe(started.run?.id);
      expect(a.worker.commands.filter((command) => command.case === "installCli")).toHaveLength(1);
    } finally {
      waiting.resolve();
      // Reported success can reach the update run before the handler sends its ACK.
      // Drain the handler before teardown closes its worker link, also on assertion failure.
      await acknowledged.promise;
    }

    await tickUntil(a, (run) => run?.state === "succeeded");
  }, 30_000);

  test("the own-app step survives a full gateway restart and the app's persisted outcome", async () => {
    const a = await gateway();
    const app = await fakeApp(a, "own app", []);
    const started = await a.api.manageUpdates({ action: "update_all", confirmRestart: true });
    await tickUntil(a, () => app.requests.length === 1);
    const storage = { pg: a.pg, secretsKey: a.secretsKey, workerId: a.workerId, workerCredential: a.workerCredential };
    await app.stop();
    await a.close(true);
    const restarted = await gateway(storage);

    const returned = await fakeApp(
      restarted,
      "own app",
      [],
      false,
      create(ui.DesktopUpdateStateSchema, {
        ...app.snapshot,
        version: "2.0.0",
        phase: "succeeded",
        ready: false,
        updaterPhase: "idle",
        updaterVersion: "",
        availableVersion: "2.0.0",
      }),
    );

    expect((await restarted.api.getUpdates({})).run?.id).toBe(started.run?.id);
    await tickUntil(restarted, (run) => run?.state === "succeeded");
    expect(returned.requests).toEqual([]);
    expect((await restarted.api.getUpdates({})).run?.steps.at(-1)?.kind).toBe("app");
  }, 60_000);
});
