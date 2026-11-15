import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { gatewayStorageOptions } from "../../apps/gateway/src/diagnostics/storage-roots.ts";
import { diagnosticReport } from "../../apps/gateway/src/diagnostics/report.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("Canopy storage through authenticated diagnostics", () => {
  const directory = tempDir("canopy-diagnostics-storage-");
  let gateway: TestGateway;
  const session = crypto.randomUUID();
  const logs = join(directory, "logs");
  const spool = join(directory, "spool");
  const updates = join(directory, "fallback-releases");
  const web = join(directory, "fallback-web");
  const project = join(updates, "private-project");

  const workerView = async () =>
    (await gateway.api.getComputerDiagnostics({})).links.find((row) => row.kind === "worker");

  const report = (sequence: bigint, storage: ui.DiagnosticsStorage) =>
    create(ui.WorkerLinkDiagnosticsSchema, {
      session,
      sequence,
      // Simulate a worker whose wall clock is one hour ahead of its gateway.
      startMs: BigInt(Date.now() + 3_599_000),
      endMs: BigInt(Date.now() + 3_600_000),
      rtt: {},
      jitter: {},
      workerMeasuresSupported: true,
      storage,
    });

  const storage = (bytes: bigint) =>
    create(ui.DiagnosticsStorageSchema, {
      status: "ready",
      component: "worker",
      sampledAtMs: BigInt(Date.now() + 3_540_000),
      categories: [{ category: "data", bytes }],
    });

  beforeAll(async () => {
    for (const path of [logs, spool, updates, web, project]) await mkdir(path, { recursive: true });
    await writeFile(join(logs, "gateway.log"), "log");
    await writeFile(join(spool, "archive.zip"), "spool");
    await writeFile(join(updates, "release"), "update");
    await writeFile(join(web, "build"), "web");
    await writeFile(join(project, "private-file"), "project-content-is-excluded");
    gateway = await startTestGateway({
      diagnostics: true,
      worker: { hello: { capabilities: ["diagnostics_v1", "worker_diagnostics_v1"] } },
      diagnosticsStorage: gatewayStorageOptions(
        {},
        { logs, spool: () => spool, updates: () => updates, web: () => web, kind: "source" },
      ),
    });
    const store = new DiagnosticsStore(gateway.runtime, gateway.userId, "local");
    const id = crypto.randomUUID();
    await store.query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Storage','storage')",
      [id, gateway.userId],
    );
    await store.query(
      "INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES($1::uuid,$2::uuid,$3::uuid,$4)",
      [crypto.randomUUID(), id, gateway.workerId, project],
    );
    const foreignId = crypto.randomUUID();

    await store.query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Windows','windows')",
      [foreignId, gateway.userId],
    );
    await store.query(
      "INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES($1::uuid,$2::uuid,$3::uuid,$4)",
      [crypto.randomUUID(), foreignId, gateway.workerId, String.raw`C:\private-project`],
    );
    await gateway.core.diagnostics.start();
    await eventually(async () => gateway.core.diagnostics.persistence?.ready, Boolean);
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("scans native runtime roots despite Windows absolute metadata, excludes projects and separates SQL size", async () => {
    const first = await gateway.api.getComputerDiagnostics({});
    expect(["measuring", "ready"]).toContain(first.storage?.status);

    const value = await eventually(
      () => gateway.api.getComputerDiagnostics({}),
      (value) => value.storage?.status === "ready",
    );

    expect(value.storage?.component).toBe("gateway");
    expect(value.storage?.categories.find((row) => row.category === "logs")?.bytes).toBe(3n);
    expect(value.storage?.categories.find((row) => row.category === "cache")?.bytes).toBe(14n);
    expect(value.storage?.categories.find((row) => row.category === "application")).toBeUndefined();
    expect(value.storage?.categories.find((row) => row.category === "database")?.bytes).toBeGreaterThan(0n);
    expect(toJsonString(ui.ComputerDiagnosticsSchema, value)).not.toContain(directory);
    const overview = await gateway.api.getDiagnostics({});
    expect(overview.computers[0]?.storage?.sampledAtMs).toBe(value.storage?.sampledAtMs);
    expect(overview.desktopStorage).toBeUndefined();
    await writeFile(join(logs, "gateway.log"), "a changed log that waits for the next bounded scan");
    expect((await gateway.api.getComputerDiagnostics({})).storage?.categories).toEqual(value.storage?.categories);
    const anonymous = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gateway.grpcUrl }));
    expect(await anonymous.getDiagnostics({}).catch((error) => ConnectError.from(error).code)).toBe(
      Code.Unauthenticated,
    );
  });

  test.each(["private-project", "C:private-project"])("relative workspace %s blocks scanning", async (path) => {
    let scans = 0;

    const blocked = await startTestGateway({
      diagnosticsStorage: {
        roots: () => {
          scans++;

          return [{ path: updates, category: "cache" }];
        },
      },
    });

    try {
      const store = new DiagnosticsStore(blocked.runtime, blocked.userId, "local");
      const id = crypto.randomUUID();

      await store.query(
        "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Relative','relative')",
        [id, blocked.userId],
      );
      await store.query(
        "INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES($1::uuid,$2::uuid,$3::uuid,$4)",
        [crypto.randomUUID(), id, blocked.workerId, path],
      );

      const value = await eventually(
        () => blocked.api.getComputerDiagnostics({}),
        (value) => value.storage?.status === "unavailable",
      );

      expect(value.storage?.sampledAtMs).toBe(0n);
      expect(value.storage?.categories).toEqual([]);
      expect(scans).toBe(0);
    } finally {
      await blocked.close();
    }
  });

  test("preserves worker scan age and strips unknown protobuf fields before serving and exporting", async () => {
    const bytes = toBinary(ui.DiagnosticsStorageSchema, storage(19n));

    const hostile = fromBinary(
      ui.DiagnosticsStorageSchema,
      new Uint8Array([...bytes, 0x9a, 0x06, 0x06, ...new TextEncoder().encode("secret")]),
    );

    const batch = report(1n, hostile);
    const before = BigInt(Date.now() - 60_000);
    gateway.worker.link.send({ case: "diagnostics", value: batch });
    const first = await eventually(workerView, (value) => value?.storage?.categories[0]?.bytes === 19n);
    expect(first?.storage?.sampledAtMs).toBeGreaterThanOrEqual(before - 100n);
    expect(first?.storage?.sampledAtMs).toBeLessThan(BigInt(Date.now() - 59_000));
    expect(first?.storage?.sampleAgeMs).toBeGreaterThanOrEqual(59_000);
    expect(Buffer.from(toBinary(ui.DiagnosticsStorageSchema, first!.storage!)).toString()).not.toContain("secret");

    // Repeating the same scan in a newer batch must not make it fresher.
    gateway.worker.link.send({ case: "diagnostics", value: { ...batch, sequence: 2n, endMs: batch.endMs + 500n } });
    await eventually(
      async () => gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`)?.watermark.sequence,
      (sequence) => sequence === 2n,
    );
    expect((await workerView())?.storage?.sampledAtMs).toBe(first?.storage?.sampledAtMs);
    gateway.worker.link.send({ case: "diagnostics", value: { ...batch, storage: storage(999n) } });
    await gateway.api.getClientCapabilities({});
    expect((await workerView())?.storage?.categories).toEqual(first?.storage?.categories);
    const view = await gateway.api.getComputerDiagnostics({});
    const exported = diagnosticReport([view], "json").text;
    expect(exported).toContain('"bytes": "19"');
    expect(exported).not.toContain("secret");
    expect(exported).not.toContain(directory);
  });

  test("invalid categories, component identities and future scans cannot replace a valid worker sample", async () => {
    const previous = (await workerView())?.storage;

    const invalid = [
      create(ui.DiagnosticsStorageSchema, { ...storage(30n), component: "gateway" }),
      create(ui.DiagnosticsStorageSchema, {
        ...storage(30n),
        categories: [create(ui.DiagnosticsStorageCategorySchema, { category: "private-path", bytes: 30n })],
      }),
      create(ui.DiagnosticsStorageSchema, { ...storage(30n), sampledAtMs: BigInt(Date.now() + 3_660_000) }),
      create(ui.DiagnosticsStorageSchema, {
        ...storage(30n),
        categories: [
          create(ui.DiagnosticsStorageCategorySchema, { category: "data", bytes: 30n }),
          create(ui.DiagnosticsStorageCategorySchema, { category: "data", bytes: 1n }),
        ],
      }),
    ];

    for (const [index, value] of invalid.entries())
      gateway.worker.link.send({ case: "diagnostics", value: report(BigInt(index + 3), value) });
    await eventually(
      async () => gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`)?.watermark.sequence,
      (sequence) => sequence === 6n,
    );
    expect((await workerView())?.storage?.sampledAtMs).toBe(previous?.sampledAtMs);
    expect((await workerView())?.storage?.categories).toEqual(previous?.categories);
  });

  test("a remote app reports its full desktop through the authenticated worker link", async () => {
    gateway.worker.link.send({
      case: "diagnostics",
      value: report(7n, create(ui.DiagnosticsStorageSchema, { ...storage(33n), component: "desktop" })),
    });
    const value = await eventually(workerView, (value) => value?.storage?.component === "desktop");
    expect(value?.storage?.categories[0]?.bytes).toBe(33n);
    const view = await gateway.api.getComputerDiagnostics({});
    expect(diagnosticReport([view], "json").text).toContain('"component": "desktop"');
  });

  test("counter reset preserves current storage, and desktop counts physical database files once", async () => {
    const previous = (await workerView())?.storage;
    await gateway.api.resetDiagnostics({
      computerId: "local",
      processId: `worker:${gateway.workerId}`,
      epoch: (await gateway.api.getComputerDiagnostics({})).epoch,
      actionId: crypto.randomUUID(),
    });
    expect((await workerView())?.storage?.sampledAtMs).toBe(previous?.sampledAtMs);
    expect((await workerView())?.storage?.categories).toEqual(previous?.categories);

    const desktop = join(directory, "desktop");
    const application = join(directory, "application");

    const entries = [
      [join(desktop, "postgres", "data"), "database", "database"],
      [join(desktop, "postgres", "versions", "pin"), "runtime", "runtime"],
      [join(desktop, "logs"), "gateway.log", "log"],
      [join(desktop, "local-worker", "data"), "journal.db", "journal"],
      [join(desktop, "local-worker", "data", "scratch"), "project", "private-project-content"],
      [application, "canopy", "app"],
    ];

    for (const [root, file, content] of entries) {
      await mkdir(root!, { recursive: true });
      await writeFile(join(root!, file!), content!);
    }

    const local = await startTestGateway({
      role: "desktop",
      diagnosticsStorage: gatewayStorageOptions(
        { CANOPY_DESKTOP_DATA_DIR: desktop, CANOPY_DESKTOP_APP_PATH: application },
        {
          logs: join(desktop, "logs"),
          spool: () => join(desktop, "spool"),
          updates: () => join(desktop, "updates"),
          web: () => undefined,
          kind: "desktop",
        },
      ),
    });

    try {
      const view = await eventually(
        () => local.api.getComputerDiagnostics({}),
        (value) => value.storage?.status === "ready",
      );

      expect(view.storage?.component).toBe("desktop");
      expect(view.storage?.categories.find((row) => row.category === "database")?.bytes).toBe(8n);
      expect(view.storage?.categories.find((row) => row.category === "application")?.bytes).toBe(10n);
      expect(view.storage?.categories.find((row) => row.category === "logs")?.bytes).toBe(3n);
      expect(view.storage?.categories.find((row) => row.category === "data")?.bytes).toBe(7n);
    } finally {
      await local.close();
    }
  });

  test("worker session restart preserves a good sample and gateway restart retains it while offline", async () => {
    const previous = (await workerView())?.storage;
    gateway.worker.link.close();

    const restarted = await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { capabilities: ["diagnostics_v1", "worker_diagnostics_v1"] },
    });

    const nextSession = crypto.randomUUID();

    const initial = {
      ...report(1n, create(ui.DiagnosticsStorageSchema, { status: "measuring", component: "worker" })),
      session: nextSession,
    };

    restarted.link.send({ case: "diagnostics", value: initial });
    await eventually(
      async () => gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`)?.watermark.session,
      (session) => session === nextSession,
    );
    expect((await workerView())?.storage?.sampledAtMs).toBe(previous?.sampledAtMs);
    expect((await workerView())?.storage?.categories).toEqual(previous?.categories);
    restarted.link.send({
      case: "diagnostics",
      value: {
        ...initial,
        sequence: 2n,
        storage: create(ui.DiagnosticsStorageSchema, { ...storage(88n), sampledAtMs: initial.endMs - 120_000n }),
      },
    });
    await eventually(
      async () => gateway.core.diagnostics.links.get(`worker:${gateway.workerId}`)?.watermark.sequence,
      (sequence) => sequence === 2n,
    );
    expect((await workerView())?.storage?.sampledAtMs).toBe(previous?.sampledAtMs);
    restarted.link.send({
      case: "diagnostics",
      value: {
        ...initial,
        sequence: 3n,
        storage: create(ui.DiagnosticsStorageSchema, { ...storage(99n), sampledAtMs: initial.endMs - 1000n }),
      },
    });
    const latest = await eventually(workerView, (value) => value?.storage?.categories[0]?.bytes === 99n);
    await gateway.core.diagnostics.persistence!.flush(true);
    const state = await gateway.core.diagnostics.persistence!.store.state();
    expect(state?.workerStorage).toHaveLength(1);
    expect(state?.workerStorage[0]?.storage?.sampledAtMs).toBe(latest?.storage?.sampledAtMs);

    const persisted = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ diagnostics: true, storage: persisted });
    gateway.worker.link.close();
    await eventually(
      async () => gateway.core.link.connections.has(gateway.workerId),
      (online) => !online,
    );
    await gateway.core.diagnostics.start();
    await gateway.core.diagnostics.persistence!.start();
    const offline = await eventually(workerView, (value) => value?.storage?.categories[0]?.bytes === 99n);
    expect(offline?.online).toBe(false);
    expect(offline?.storage?.sampledAtMs).toBe(latest?.storage?.sampledAtMs);
    expect(offline?.storage?.sampleAgeMs).toBeGreaterThanOrEqual(latest!.storage!.sampleAgeMs);
  });
});
