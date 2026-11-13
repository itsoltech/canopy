import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { nodeRef, REMOTE_APP_UPDATE, REMOTE_THREADS } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { methodNamed } from "../../apps/gateway/src/computers/remote.ts";
import { serveComputerUpdates } from "../../apps/gateway/src/updates/linked.ts";
import { UpdateRunStore } from "../../apps/gateway/src/updates/run-store.ts";
import { updatePlan } from "../../apps/gateway/src/updates/center-plan.ts";
import { LocalDesktopControl } from "../../apps/desktop/src/local-control.ts";
import { PROGRESS_REPORT_MS, RemoteAppUpdate } from "../../apps/desktop/src/remote-app-update.ts";
import { computerUpdate } from "../../apps/web/src/lib/features/workers/computer-updates.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually as poll, startTestGateway, type TestGateway } from "./support/gateway.ts";

const makeTemp = tempDirs();

const failure = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (cause: unknown) => {
      const error = ConnectError.from(cause);

      return { code: error.code, rawMessage: error.rawMessage };
    },
  );

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 10_000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** B's Canopy app: the real control channel and update policy around a scripted updater. */
class FakeApp {
  status: DesktopUpdateStatus;
  idle = false;
  restarted = false;
  checks = 0;
  checkGate?: Promise<void>;
  notified: string[] = [];
  reports = 0;
  /** Reports like an app from before the updater fields: the gateway gets none of them. */
  legacy = false;
  readonly control: LocalDesktopControl;
  readonly coordinator: RemoteAppUpdate;
  private readonly loop: Promise<void>;
  constructor(gateway: TestGateway, path: string, version: string, available?: string) {
    this.status = {
      version,
      channel: "nightly",
      buildChannel: "nightly",
      phase: "idle",
      message: "Up to date",
      changingChannel: false,
      updateVersion: available,
    };
    this.control = new LocalDesktopControl(gateway.api, gateway.workerId, (command) => {
      if (command.check) {
        this.checks++;
        this.status = { ...this.status, phase: "checking", lastCheckedAt: Date.now() };
        void this.coordinator.publish().then(async () => {
          await this.checkGate;
          this.status = { ...this.status, phase: "idle", updateVersion: available };
          await this.coordinator.publish();
        });
      } else void this.coordinator.command(command);
    });
    this.coordinator = new RemoteAppUpdate(path, {
      status: () => this.status,
      check: async () => {
        this.status = { ...this.status, phase: "downloaded", updateVersion: available };

        return this.status;
      },
      drain: async () => this.idle,
      notify: (by) => this.notified.push(by),
      restart: () => {
        this.restarted = true;
      },
      report: (state) => {
        this.reports++;

        const sent = this.legacy
          ? { ...state, updaterPhase: "", updaterVersion: "", updaterProgress: 0, updaterError: "" }
          : state;

        return this.control.report(toJsonString(ui.DesktopUpdateStateSchema, sent));
      },
    });
    void this.coordinator.publish();
    this.loop = this.control.run();
  }
  async stop() {
    this.coordinator.stop();
    this.control.stop();
    await this.loop;
  }
}

/** docs/updates.md, "Połączone komputery": computer A sees and updates computer B's Canopy app over the link. */
describe.skipIf(!dockerAvailable)("linked computers' app updates", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let app: FakeApp;
  let localApp: FakeApp | undefined;
  let bNode = "";
  let journal = "";

  const linkedB = (port: number, capable = true) =>
    linkedComputers({
      store: new ComputerStore(b.runtime, b.userId, b.secretsKey),
      host: "127.0.0.1",
      port,
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(b.core), b.core),
      ...(capable && { updates: (nodeId, method, request) => serveComputerUpdates(b.core, nodeId, method, request) }),
      capabilities: ["presence", "unlink", REMOTE_THREADS, ...(capable ? [REMOTE_APP_UPDATE] : [])],
    });

  /** B's updater moves by itself (an automatic check); the app reports it like its main process does. */
  function updater(change: Partial<DesktopUpdateStatus>) {
    app.status = { ...app.status, ...change };
    void app.coordinator.publish();
  }

  /** B quits for its update (presence "updating") and starts again on the same port. */
  async function restartB(capable = true) {
    const port = Number(new URL(lb.addresses[0]!).port);
    await lb.close("updating");
    await eventually(async () => (await computer())?.presence === "updating");
    lb = linkedB(port, capable);
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await lb.start();
    await eventually(async () => la.reachable().includes(bNode), 15_000);
  }

  const computer = async () => (await a.api.getUpdates({})).computers.find((c) => c.nodeId === bNode);

  const audit = async (gateway: TestGateway, action: string) =>
    (
      await new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey).query<{
        details: { node?: string };
      }>("SELECT details FROM audit_log WHERE action=$1 ORDER BY created_at", [action])
    ).map((row) => row.details);

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    la = linkedComputers({
      store: new ComputerStore(a.runtime, a.userId, randomBytes(32)),
      host: "127.0.0.1",
      port: await freePort(),
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(a.core), a.core),
      updates: (nodeId, method, request) => serveComputerUpdates(a.core, nodeId, method, request),
      capabilities: ["presence", "unlink", REMOTE_THREADS, REMOTE_APP_UPDATE],
    });
    lb = linkedB(await freePort());
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    bNode = lb.hello().nodeId;
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await eventually(async () => la.reachable().includes(bNode), 15_000);
    journal = join(makeTemp("canopy-linked-app-"), "remote-update.json");
    app = new FakeApp(b, journal, "1.0.0", "1.1.0");
  }, 90_000);
  afterAll(async () => {
    await localApp?.stop();
    await app?.stop();
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("A sees B's app version, its available update and B's workers under B's node", async () => {
    await eventually(async () => (await computer())?.updates?.app?.connected === true);
    const b1 = (await computer())!;
    expect([b1.presence, b1.remoteUpdate, b1.reason]).toEqual(["connected", true, ""]);
    expect([b1.updates?.app?.version, b1.updates?.app?.availableVersion, b1.updates?.app?.channel]).toEqual([
      "1.0.0",
      "1.1.0",
      "nightly",
    ]);
    expect(b1.updates?.workers.map((w) => w.workerId)).toContain(`${b.workerId}~${nodeRef(bNode)}`);
    // B answers with its own snapshot only: A does not come back through B.
    expect(b1.updates?.computers).toEqual([]);
  }, 20_000);

  test("B's own download reaches A with its progress and target, a report at most once a second", async () => {
    updater({ phase: "downloading", progress: 12, updateVersion: "1.1.0", message: "Downloading" });
    await eventually(async () => (await computer())?.updates?.app?.updaterProgress === 12);
    expect((await computer())?.updates?.app).toMatchObject({ updaterPhase: "downloading", updaterVersion: "1.1.0" });
    expect(computerUpdate((await computer())!)).toMatchObject({
      status: "12%",
      target: "1.1.0",
      progress: 12,
      busy: true,
      actionable: false,
    });

    // Progress events come fast; the gateway gets one report now and the last one after the interval.
    const before = app.reports;

    for (let progress = 13; progress <= 60; progress++) updater({ progress });
    expect(app.reports - before).toBeLessThanOrEqual(1);
    await eventually(async () => (await computer())?.updates?.app?.updaterProgress === 60);
    expect(app.reports - before).toBeLessThanOrEqual(2);
    await Bun.sleep(PROGRESS_REPORT_MS);
    expect(app.reports - before).toBeLessThanOrEqual(2);

    // Downloaded: Ready with the version it installs, and Update restarts it on A's request.
    updater({ phase: "downloaded", progress: 100, stagedVersion: "1.1.0", message: "Restart to update" });
    await eventually(async () => computerUpdate((await computer())!).status === "Ready");
    expect(computerUpdate((await computer())!)).toMatchObject({ target: "1.1.0", actionable: true, busy: false });

    updater({ phase: "error", progress: undefined, error: "The download was interrupted." });
    await eventually(async () => computerUpdate((await computer())!).status === "Failed");
    expect(computerUpdate((await computer())!).detail).toBe("The download was interrupted.");
    updater({ phase: "idle", error: undefined, stagedVersion: undefined, message: "Update available" });
    await eventually(async () => (await computer())?.updates?.app?.updaterPhase === "idle");
  }, 60_000);

  test("an older B without the updater fields shows the row it showed before", async () => {
    app.legacy = true;
    updater({ phase: "downloading", progress: 40, message: "Downloading" });
    await eventually(async () => (await computer())?.updates?.app?.updaterPhase === "");
    expect(computerUpdate((await computer())!)).toMatchObject({
      status: "Available",
      target: "1.1.0",
      progress: undefined,
      actionable: true,
    });
    app.legacy = false;
    updater({ phase: "idle", progress: undefined, message: "Update available" });
    await eventually(async () => (await computer())?.updates?.app?.updaterPhase === "idle");
  }, 20_000);

  test("Check now checks the local app and B's app, and repeated presses are throttled", async () => {
    const local = new FakeApp(a, join(makeTemp("canopy-local-app-check-"), "remote-update.json"), "1.0.0", "1.1.0");
    const gate = Promise.withResolvers<void>();
    local.checkGate = gate.promise;
    await eventually(async () => (await a.api.getUpdates({})).app?.connected === true);

    try {
      // The test gateway's own release check isn't running; the linked computers' checks go out anyway.
      let finished = false;

      const check = a.api
        .manageUpdates({ action: "check" })
        .catch(() => undefined)
        .then(() => {
          finished = true;
        });

      const repeated = a.api.manageUpdates({ action: "check" }).catch(() => undefined);
      await eventually(async () => (await a.api.getUpdates({})).app?.updaterPhase === "checking");
      expect(finished).toBe(false);
      expect(local.checks).toBe(1);
      gate.resolve();
      await Promise.all([check, repeated]);
      await eventually(async () => app.checks > 0);
      expect(local.checks).toBe(1);
      expect((await a.api.getUpdates({})).app).toMatchObject({
        availableVersion: "1.1.0",
        lastCheckedAtMs: local.status.lastCheckedAt,
        requestId: "",
      });
      expect(local.restarted).toBe(false);
      expect(local.notified).toEqual([]);
      // Check now on one linked computer (Settings → App updates).
      const before = app.checks;
      await a.api.manageUpdates({ action: "computer_check", nodeId: bNode });
      expect(app.checks).toBe(before);
      await a.api.manageUpdates({ action: "check" }).catch(() => undefined);
      expect(local.checks).toBe(1);
      expect(app.checks).toBe(before);
      await eventually(async () => (await computer())?.updates?.app?.lastCheckedAtMs === app.status.lastCheckedAt);
    } finally {
      gate.resolve();
      await local.stop();
    }
  }, 20_000);

  test("an update of B is routed and audited, waits for idle on B, restarts and comes back on the new version", async () => {
    await a.api.manageUpdates({ action: "computer", nodeId: bNode });
    expect(app.notified).toEqual([la.hello().name]);
    // A turn runs on B: the app waits for idle and does not restart.
    await eventually(async () => (await computer())?.updates?.app?.phase === "waiting_idle");
    await Bun.sleep(1500);
    expect(app.restarted).toBe(false);
    expect((await computer())?.updates?.app).toMatchObject({ targetVersion: "1.1.0", ready: true });
    app.idle = true;
    await eventually(async () => app.restarted);
    // The planned departure closes peer reads immediately; the last app snapshot may still say waiting_idle.
    await eventually(async () => ["updating", "restarting"].includes((await computer())?.presence ?? ""));
    expect((await audit(a, "computer.update.sent")).map((d) => d.node)).toEqual([bNode]);
    expect((await audit(b, "desktop.update.request")).map((d) => d.node)).toEqual([la.hello().nodeId]);
    expect((await audit(b, "computer.update.received")).map((d) => d.node)).toEqual([la.hello().nodeId]);

    // B quits for the update: A shows it restarting, not an error, and refreshes when it is back.
    await app.stop();
    await restartB();
    app = new FakeApp(b, journal, "1.1.0");
    await eventually(async () => (await computer())?.updates?.app?.version === "1.1.0");
    expect((await computer())?.updates?.app?.phase).toBe("succeeded");
    await eventually(async () => (await audit(b, "desktop.update.outcome")).length === 1);
  }, 60_000);

  test("Update all on A updates B last and tolerates B going offline while it restarts", async () => {
    // Replace the earlier check-only app's disconnected snapshot with an up-to-date local app.
    localApp = new FakeApp(a, join(makeTemp("canopy-local-app-current-"), "remote-update.json"), "1.1.0");
    await eventually(async () => (await a.api.getUpdates({})).app?.version === "1.1.0");
    await app.stop();
    app = new FakeApp(b, journal, "1.1.0", "1.2.0");
    app.idle = true;
    await eventually(async () => (await computer())?.updates?.app?.availableVersion === "1.2.0");
    // The finished request still names 1.1.0; the row aims at the newer release.
    expect((await computer())?.updates?.app).toMatchObject({ phase: "succeeded", targetVersion: "1.1.0" });
    expect(computerUpdate((await computer())!).target).toBe("1.2.0");
    await a.api.manageUpdates({ action: "update_all" });
    const steps = async () => (await a.api.getUpdates({})).run?.steps ?? [];
    const computerStep = async () => (await steps()).find((s) => s.kind === "computer");
    expect((await steps()).at(-1)?.kind).toBe("computer");
    expect((await computerStep())?.label).toBe(`${(await computer())?.name} · Canopy app`);

    for (let i = 0; i < 100 && !app.restarted; i++) {
      await a.core.updateCenter.tick();
      await Bun.sleep(100);
    }

    expect(app.restarted).toBe(true);
    await app.stop();
    const port = Number(new URL(lb.addresses[0]!).port);
    await lb.close("updating");
    await eventually(async () => (await computer())?.presence === "updating");
    // Offline during the restart: the step keeps waiting, the run does not fail.
    await a.core.updateCenter.tick();
    expect((await computerStep())?.state).toBe("running");
    lb = linkedB(port);
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await lb.start();
    app = new FakeApp(b, journal, "1.2.0");
    await eventually(async () => {
      await a.core.updateCenter.tick();

      return (await computerStep())?.state === "succeeded";
    }, 20_000);
    await a.core.updateCenter.tick();
    expect((await a.api.getUpdates({})).run?.state).toBe("succeeded");
  }, 60_000);

  test("a stopped linked update reconciles current facts after a gateway restart without launching later steps", async () => {
    const requestId = app.coordinator.snapshot().requestId;
    await app.stop();
    writeFileSync(
      journal,
      toJsonString(
        ui.DesktopUpdateStateSchema,
        create(ui.DesktopUpdateStateSchema, {
          requestId,
          phase: "failed",
          targetVersion: "1.3.0",
          version: "1.2.0",
          reason: "The app restarted before the update completed. Request it again.",
        }),
      ),
    );
    app = new FakeApp(b, journal, "1.2.0", "1.3.0");
    await eventually(async () => (await computer())?.updates?.app?.phase === "failed");

    const run = create(ui.UpdateRunSchema, {
      id: crypto.randomUUID(),
      state: "failed",
      reason: "Canopy app: The app restarted before the update completed.",
      steps: [
        { kind: "computer", nodeId: bNode, requestId, version: "1.3.0", fromVersion: "1.2.0", state: "failed" },
        { kind: "computer", nodeId: "c".repeat(64), version: "2.0.0", state: "queued" },
      ],
    });

    await new UpdateRunStore(a.runtime, a.userId).write(run);
    expect((await a.api.getUpdates({})).run?.state).toBe("failed");
    const key = la.options.store.key;
    const port = Number(new URL(la.addresses[0]!).port);
    await la.close();
    const storage = { pg: a.pg, secretsKey: a.secretsKey, workerId: a.workerId, workerCredential: a.workerCredential };
    await a.close(true);
    a = await startTestGateway({ role: "desktop", storage });
    la = linkedComputers({
      store: new ComputerStore(a.runtime, a.userId, key),
      host: "127.0.0.1",
      port,
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(a.core), a.core),
      updates: (nodeId, method, request) => serveComputerUpdates(a.core, nodeId, method, request),
      capabilities: ["presence", "unlink", REMOTE_THREADS, REMOTE_APP_UPDATE],
    });
    a.core.computers = la;
    a.core.network = la.options.network;
    await la.start();
    await eventually(async () => la.reachable().includes(bNode), 15_000);
    expect((await a.api.getUpdates({})).run?.state).toBe("failed");
    await app.stop();
    app = new FakeApp(b, journal, "1.4.0");
    await eventually(async () => (await a.api.getUpdates({})).run?.state === "superseded", 20_000);
    expect(await new UpdateRunStore(a.runtime, a.userId).read()).toMatchObject({
      id: run.id,
      state: "superseded",
      reason: "",
      steps: [{ state: "succeeded", reason: "" }, { state: "queued" }],
    });
    expect(app.checks).toBe(0);
    expect(app.restarted).toBe(false);
    expect((await computer())?.updates?.app).toMatchObject({ phase: "succeeded", version: "1.4.0" });
  }, 60_000);

  for (const form of ["qualified", "plain"]) {
    test(`dismissing a linked app failure with a ${form} ID replaces cached state with the acknowledged request`, async () => {
      await app.stop();
      app = new FakeApp(b, journal, "1.4.0", "1.5.0");
      await eventually(
        async () =>
          b.core.appControl.snapshot().connected && (await computer())?.updates?.app?.availableVersion === "1.5.0",
      );
      const previousRequestId = app.coordinator.snapshot().requestId;
      await a.api.manageUpdates({ action: "computer", nodeId: bNode });
      await eventually(async () => (await computer())?.updates?.app?.phase === "waiting_idle");
      const requestId = (await computer())?.updates?.app?.requestId ?? "";
      const plainId = app.coordinator.snapshot().requestId;
      expect(previousRequestId).not.toBe("");
      expect(plainId).not.toBe(previousRequestId);
      expect(requestId).toBe(`${plainId}~${nodeRef(bNode)}`);
      await app.stop();
      app = new FakeApp(b, journal, "1.4.0", "1.5.0");
      await eventually(async () => (await computer())?.updates?.app?.phase === "failed");

      for (const desktopRequestId of [previousRequestId, `${plainId}~${nodeRef(la.hello().nodeId)}`]) {
        expect(
          await failure(a.api.manageUpdates({ action: "computer_dismiss", nodeId: bNode, desktopRequestId })),
        ).toMatchObject({ code: desktopRequestId.includes("~") ? Code.InvalidArgument : Code.FailedPrecondition });
        expect(b.core.appControl.snapshot()).toMatchObject({ requestId: plainId, phase: "failed" });
      }

      const value = await a.api.manageUpdates({
        action: "computer_dismiss",
        nodeId: bNode,
        desktopRequestId: form === "qualified" ? requestId : plainId,
      });

      expect(value.computers.find((computer) => computer.nodeId === bNode)?.updates?.app).toMatchObject({
        requestId,
        phase: "idle",
        reason: "",
      });
      expect((await computer())?.updates?.app).toMatchObject({ requestId, phase: "idle", reason: "" });
      await eventually(async () => app.coordinator.snapshot().phase === "idle");
      expect(app.coordinator.snapshot()).toMatchObject({ requestId: plainId, phase: "idle", reason: "" });
      expect(app.restarted).toBe(false);
    }, 30_000);
  }

  test("another owner's computer cannot ask B for an update or dismiss its failure", async () => {
    const method = methodNamed("RequestComputerUpdate")!;

    for (const action of ["app", "check", "dismiss"]) {
      const request = create(link.ComputerUpdateRequestSchema, { action });
      expect(await failure(serveComputerUpdates(b.core, "f".repeat(64), method, request))).toMatchObject({
        code: Code.PermissionDenied,
      });
    }
  });

  test("an older local desktop receives the check command without waiting for a timestamp", async () => {
    const setRole = (role: string) =>
      a.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE users SET role = ${role} WHERE id = ${a.userId}::uuid`;
        }),
      );

    const abort = new AbortController();

    const stream = a.api
      .watchAppControl(
        {
          workerId: a.workerId,
          version: "1.0.0",
          channel: "nightly",
          remoteUpdate: true,
        },
        { signal: abort.signal, timeoutMs: 3000 },
      )
      [Symbol.asyncIterator]();

    try {
      await setRole("user");
      const opened = await stream.next();
      await a.api.reportAppControl({
        sessionId: opened.value!.sessionId,
        state: { workerId: a.workerId, version: "1.0.0", channel: "nightly", phase: "idle" },
      });
      const request = a.api.manageUpdates({ action: "check" });
      expect((await stream.next()).value?.command?.check).toBe(true);
      expect((await request).admin).toBe(false);
      expect((await a.api.getUpdates({})).app?.lastCheckedAtMs).toBe(0);
    } finally {
      await setRole("admin");
      abort.abort();
      await stream.return?.();
    }
  });

  test("B without the capability shows its version and a readable status, with no action", async () => {
    await app.stop();
    await restartB(false);
    await eventually(async () => (await computer())?.presence === "connected");
    const b1 = (await computer())!;
    const name = b1.name;
    expect([b1.remoteUpdate, b1.reason, b1.updates]).toEqual([false, `Update ${name} on that computer.`, undefined]);
    expect(b1.version).not.toBe("");
    expect(await failure(a.api.manageUpdates({ action: "computer", nodeId: bNode }))).toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: `Update ${name} on that computer.`,
    });
    // Update all leaves it out.
    expect(
      updatePlan(await a.api.getUpdates({})).steps.some((step) => step.kind === "computer" && step.nodeId === bNode),
    ).toBe(false);
  }, 40_000);

  test("after Unlink, A cannot reach B's app", async () => {
    await a.api.manageComputer({ action: "unlink", nodeId: bNode });
    expect(await failure(a.api.manageUpdates({ action: "computer", nodeId: bNode }))).toMatchObject({
      code: Code.NotFound,
    });
    expect((await a.api.getUpdates({})).computers).toEqual([]);
  }, 20_000);
});
