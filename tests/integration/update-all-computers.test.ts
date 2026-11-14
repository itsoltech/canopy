import { afterEach, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { CliInstallMethod, CliToolsReportSchema, Provider, ui, update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { REMOTE_APP_UPDATE, REMOTE_THREADS, CONFIG_SYNC } from "@canopy/domain/computers";
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
    worker: { hello: { capabilities: ["cli_install", "desktop_bundled"] } },
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

async function linkGateways(a: TestGateway, b: TestGateway, name = "Linked computer") {
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
      capabilities: ["presence", "unlink", REMOTE_THREADS, REMOTE_APP_UPDATE, CONFIG_SYNC],
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
    gateway.workerId,
    create(CliToolsReportSchema, {
      os: "linux",
      arch: "x64",
      tools: [Provider.CLAUDE, Provider.CODEX].map((provider, index) => ({
        provider,
        version: versions[index] || "",
        installable: true,
        method: index === 0 ? CliInstallMethod.NATIVE : CliInstallMethod.NPM,
        ...(state && {
          install: {
            installId: "fixture",
            state: fail && index === 0 ? "failed" : state,
            error: fail && index === 0 ? "Download failed. Retry the update." : "",
          },
        }),
      })),
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
  test("linked apps overlap after their CLIs; duplicate clicks and a restart retain the same run", async () => {
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
      await eventually(
        async () =>
          (await a.api.getUpdates({})).computers[0]?.updates?.cliWorkers.some((worker) => worker.cliTools.length === 2),
        Boolean,
      ),
    ).toBe(true);

    for (const [target, name] of [
      [a, "local"],
      [b, "linked"],
    ] as const) {
      target.worker.handlers.set("installCli", async (value, reply) => {
        if (value.$typeName !== "canopy.worker.v1.InstallCli") throw new Error("Expected CLI command");
        events.push(`${name} CLI ${value.provider}`);
        const codexDone = name === "local" || events.includes(`${name} CLI ${Provider.CODEX}`);
        await clis(target, ["2.0.0", codexDone ? "2.0.0" : "1.0.0"], "succeeded");
        reply(true);
      });
    }

    expect(await failure(a.api.manageUpdates({ action: "update_all" }))).toContain("Confirm the computer restart");
    const started = await a.api.manageUpdates({ action: "update_all", confirmRestart: true });
    expect(started.run?.steps.map((step) => step.kind)).toEqual(["cli", "cli", "cli", "computer", "computer", "app"]);
    const duplicate = await a.api.manageUpdates({ action: "update_all" });
    expect(duplicate.run?.id).toBe(started.run?.id);
    await tickUntil(a, () => linked.requests.length === 1);
    expect(
      (await a.api.getUpdates({})).run?.steps
        .filter((step) => step.kind === "cli")
        .map((step) => [step.state, step.reason]),
    ).toEqual([
      ["succeeded", ""],
      ["succeeded", ""],
      ["succeeded", ""],
    ]);
    expect(events.filter((event) => event.includes(" CLI ")).sort()).toEqual(
      [`local CLI ${Provider.CLAUDE}`, `linked CLI ${Provider.CLAUDE}`, `linked CLI ${Provider.CODEX}`].sort(),
    );
    expect(own.requests).toEqual([]);
    await tickUntil(a, () => second.requests.length === 1);
    expect(second.requests).toHaveLength(1);
    await linked.finish();
    refreshComputerUpdates(a.core, nodeId);
    await tickUntil(a, () => second.requests.length === 1);
    expect(own.requests).toEqual([]);
    await second.finish();
    refreshComputerUpdates(a.core, secondNode);
    await tickUntil(a, () => own.requests.length === 1);
    expect(events.at(-1)).toBe("own app");
    a.core.updateCenter.stop();
    const resumed = createUpdateCenter(a.core);
    expect((await resumed.status())?.id).toBe(started.run?.id);
    await resumed.tick();
    expect(own.requests).toHaveLength(1);
    await own.finish();
    await resumed.tick();
    await resumed.tick();
    expect((await resumed.status())?.state).toBe("succeeded");
    expect(
      (await new UpdateRunStore(a.runtime, a.userId).read())?.steps.every((step) => step.state === "succeeded"),
    ).toBe(true);
  }, 90_000);

  test("one CLI fails without aborting other CLIs or the linked app; retry preserves successful history", async () => {
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
    expect(stopped.steps.map((step) => step.state)).toEqual(["failed", "succeeded", "succeeded"]);
    expect(stopped.steps[0]?.reason).toContain("Download failed");
    expect(
      await failure(
        a.api.manageUpdates({ action: "retry_step", desktopRequestId: crypto.randomUUID(), updateStepIndex: 0 }),
      ),
    ).toContain("current results");
    a.worker.handlers.set("installCli", async (_value, reply) => {
      await clis(a, ["2.0.0", "2.0.0"], "succeeded");
      reply(true);
    });
    await a.api.manageUpdates({ action: "retry_step", desktopRequestId: started.run?.id || "", updateStepIndex: 0 });
    await tickUntil(a, (run) => run?.state === "succeeded");
    expect(linked.requests).toHaveLength(1);
    expect((await a.api.getUpdates({})).run?.id).toBe(started.run?.id);
  }, 90_000);

  test("slow installer acknowledgements leave progress readable and a second click returns the existing run", async () => {
    const a = await gateway();
    await clis(a, ["1.0.0", "2.0.0"]);
    const waiting = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    a.worker.handlers.set("installCli", async (_value, reply) => {
      received.resolve();
      await waiting.promise;
      await clis(a, ["2.0.0", "2.0.0"], "succeeded");
      reply(true);
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
    }

    await tickUntil(a, (run) => run?.state === "succeeded");
  }, 30_000);

  test("the own-app final step survives a full gateway restart and the app's persisted outcome", async () => {
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
