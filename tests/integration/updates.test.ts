import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { connect as http2Connect } from "node:http2";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ui, update } from "@canopy/contracts";
import { createWorkerLink } from "@canopy/gateway/worker-link";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { createGrpcClientTransport, startGrpcServer } from "@canopy/transport";
import {
  ReleaseMirror,
  ReleaseSource,
  confirmStartup,
  readUpdateRecord,
  stageBinaryUpdate,
  type ReleaseManifest,
} from "../../packages/updater/src/index.ts";
import { GatewayUpdateService } from "../../apps/gateway/src/updates/service.ts";
import { WorkerUpdates } from "../../apps/worker/src/update-link.ts";
import { GatewayUpdates } from "../../apps/gateway/src/updates/runtime.ts";
import type { WorkerUpdateRow } from "../../apps/gateway/src/updates/persistence.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const headers = { authorization: "Bearer credential" };

const hello = {
  workerId: "worker",
  version: "1.0.0",
  minWorkerLinkProtocol: 1,
  workerLinkProtocol: 1,
  os: "linux",
  arch: "x64",
  installKind: "binary",
};

async function refused(promise: Promise<unknown>, code: Code): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(error).toBeInstanceOf(ConnectError);
  expect((error as ConnectError).code).toBe(code);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "canopy-update-integration-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let downloads = 0;
  const bytes = '#!/bin/sh\nprintf "2.0.0\\n"\n';
  const sha = createHash("sha256").update(bytes).digest("hex");

  const manifest: ReleaseManifest = {
    schema: 1,
    version: "2.0.0",
    channel: "v2.0.0",
    commit: "abcdef0",
    published_at: "2026-11-03T00:00:00Z",
    protocol: { worker_link: 1, update: 1 },
    assets: ["worker", "gateway"].map((app) => ({
      app: app as "worker" | "gateway",
      os: "linux",
      arch: "x64",
      name: `canopy-${app}-linux-x64`,
      url: "https://release.fixture/binary",
      sha256: sha,
      size: Buffer.byteLength(bytes),
    })),
  };

  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === "/releases/tags/2.0.0")
        return Response.json({
          tag_name: "2.0.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "manifest.json", browser_download_url: "https://release.fixture/manifest" }],
        });

      if (path === "/manifest") return Response.json(manifest);

      if (path === "/binary") {
        downloads++;

        return new Response(bytes);
      }

      return new Response("not found", { status: 404 });
    },
  });

  cleanups.push(() => {
    upstream.stop(true);
  });

  const source = new ReleaseSource({
    baseUrl: "https://release.fixture",
    fetch: (input, init) => fetch(new URL(new URL(String(input)).pathname, upstream.url), init),
  });

  const mirror = new ReleaseMirror(join(dir, "cache"), "2.0.0", source);
  const reports: update.ReportRequest[] = [];
  let valid = true;

  const service = new GatewayUpdateService({
    version: "2.0.0",
    mirror,
    authenticate: async (credential) => (valid && credential === "credential" ? "worker" : undefined),
    hello: async () => {},
    command: async () => undefined,
    report: async (_id, report) => {
      reports.push(report);
    },
    authIntervalMs: 20,
  });

  const link = createWorkerLink({
    authenticate: service.options.authenticate,
    welcome: async () => ({ heartbeatIntervalSeconds: 15 }),
  });

  const server = await startGrpcServer({
    routes: (router) => {
      link.routes(router);
      service.routes(router);
    },
    health: () => ({ healthy: true, version: "2.0.0" }),
  });

  cleanups.push(async () => {
    service.close();
    await link.shutdown();
    await server.close(50);
  });
  const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: server.url }));

  return {
    dir,
    bytes,
    manifest,
    mirror,
    reports,
    service,
    server,
    client,
    downloads: () => downloads,
    revoke: () => {
      valid = false;
      service.disconnect("worker");
    },
  };
}

describe.skipIf(process.platform === "win32")("standalone supervisor handover", () => {
  let builds: string;
  const versions = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"];
  beforeAll(async () => {
    builds = await mkdtemp(join(tmpdir(), "canopy-supervisor-builds-"));

    for (const version of versions) {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures/updater-binary.ts")],
        target: "bun",
        define: { "process.env.CANOPY_VERSION": JSON.stringify(version) },
        compile: { outfile: join(builds, version) },
      });

      if (!result.success) throw new AggregateError(result.logs, "Supervisor fixture compilation failed");
    }
  }, 60_000);
  afterAll(async () => {
    if (builds) await rm(builds, { recursive: true, force: true });
  });

  interface Event {
    type: string;
    version: string;
    pid: number;
    parent?: number;
    args?: string[];
    active?: boolean;
    exitCode?: number;
    message?: string;
  }

  const residentHealthy = (all: Event[], version: string) =>
    all.some(
      (event, index) =>
        event.type === "supervisor" &&
        event.version === version &&
        all.slice(index + 1).some((next) => next.type === "healthy" && next.version === version),
    );

  async function start(env: NodeJS.ProcessEnv = {}, alreadyConfirmed = false) {
    const directory = await mkdtemp(join(tmpdir(), "canopy-supervisor-process-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const binaryPath = join(directory, "installed");
    await copyFile(join(builds, "1.0.0"), binaryPath);

    async function stage(version: string, previousVersion: string) {
      const bytes = await readFile(join(builds, version));
      await stageBinaryUpdate({
        binaryPath,
        currentVersion: previousVersion,
        version,
        commandId: `update-${version}`,
        asset: {
          app: "worker",
          os: process.platform === "darwin" ? "darwin" : "linux",
          arch: process.arch === "arm64" ? "arm64" : "x64",
          name: "fixture",
          url: "https://release.fixture/binary",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        chunks: (async function* () {
          yield bytes;
        })(),
      });
    }

    if (alreadyConfirmed) {
      await stage("2.0.0", "1.0.0");
      await confirmStartup(binaryPath, "2.0.0");
    }

    // In the startup regression, A is already mapped while the installed, confirmed executable is B.
    const proc = Bun.spawn([alreadyConfirmed ? join(builds, "1.0.0") : binaryPath, "--fixture-arg"], {
      env: { ...process.env, ...env, CANOPY_TEST_DIRECTORY: directory, CANOPY_SUPERVISED: "" },
      stdout: "ignore",
      stderr: "pipe",
    });

    const errors = new Response(proc.stderr).text();
    cleanups.push(async () => {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
      expect(await errors).toBe("");
    });

    async function events(): Promise<Event[]> {
      try {
        return (await readFile(join(directory, "events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Event);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }

    async function wait(predicate: (events: Event[]) => boolean) {
      const deadline = Date.now() + 8000;

      for (;;) {
        const all = await events();

        if (predicate(all)) return all;

        if (proc.exitCode !== null || Date.now() >= deadline)
          throw new Error(
            `Supervisor fixture did not reach expected state: ${JSON.stringify(all)}; ${proc.exitCode === null ? "still running" : await errors}`,
          );
        await Bun.sleep(10);
      }
    }

    const command = (value: { idle?: boolean; restart?: boolean }) =>
      writeFile(join(directory, "command.json"), JSON.stringify(value));

    return { proc, stage, events, wait, command, binaryPath };
  }

  for (const app of ["worker", "gateway"]) {
    test(`${app}: A -> B -> C replaces supervisor code with the same PID after active work drains`, async () => {
      const f = await start({ CANOPY_TEST_APP: app, CANOPY_TEST_BUSY_VERSION: "2.0.0" });
      await f.wait((all) => all.some((e) => e.type === "healthy" && e.version === "1.0.0"));
      await f.stage("2.0.0", "1.0.0");
      await f.command({ restart: true });
      await f.wait((all) => all.some((e) => e.type === "drain" && e.version === "2.0.0"));
      await Bun.sleep(80);
      expect((await f.events()).filter((e) => e.type === "supervisor").map((e) => e.version)).toEqual(["1.0.0"]);
      expect((await f.events()).some((e) => e.type === "stopped" && e.version === "2.0.0")).toBe(false);
      await f.command({ idle: true });
      await f.wait((all) => residentHealthy(all, "2.0.0"));
      await f.stage("3.0.0", "2.0.0");
      await f.command({ restart: true });
      const all = await f.wait((events) => residentHealthy(events, "3.0.0"));
      const supervisors = all.filter((e) => e.type === "supervisor");
      expect(supervisors.map((e) => e.version)).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
      expect(supervisors.every((e) => e.pid === f.proc.pid && e.args?.[0] === "--fixture-arg")).toBe(true);
      expect(all.filter((e) => e.type === "child").every((e) => e.parent === f.proc.pid)).toBe(true);
      expect(all.filter((e) => e.exitCode === 76).every((e) => e.active === false)).toBe(true);
      expect(all.some((e) => e.message?.includes("rolled back"))).toBe(false);
      expect(await readUpdateRecord(f.binaryPath)).toBeUndefined();
      await Bun.sleep(80);
      expect((await f.events()).filter((e) => e.type === "supervisor")).toHaveLength(3);
    }, 20_000);
  }

  for (const failure of ["23", "75", "76", "timeout"]) {
    test(`unconfirmed candidate (${failure}) rolls back without handing over`, async () => {
      const f = await start({ CANOPY_TEST_FAILURE: failure });
      await f.wait((all) => all.some((e) => e.type === "healthy"));
      await f.stage("4.0.0", "1.0.0");
      await f.command({ restart: true });

      const all = await f.wait(
        (events) => events.filter((e) => e.type === "healthy" && e.version === "1.0.0").length === 2,
      );

      expect(all.filter((e) => e.type === "supervisor").map((e) => e.version)).toEqual(["1.0.0"]);
      expect(all.some((e) => e.exitCode === 76)).toBe(false);
      expect(await readUpdateRecord(f.binaryPath)).toMatchObject({
        state: "failed",
        reason: expect.stringContaining(failure === "timeout" ? "deadline" : `exit ${failure}`),
      });
    }, 10_000);
  }

  test("an update staged during handover keeps its watchdog and can still roll back", async () => {
    const f = await start({ CANOPY_TEST_BUSY_VERSION: "2.0.0" });
    await f.wait((all) => all.some((e) => e.type === "healthy"));
    await f.stage("2.0.0", "1.0.0");
    await f.command({ restart: true });
    await f.wait((all) => all.some((e) => e.type === "drain" && e.version === "2.0.0"));
    // Replacement races with B's drain: exit 76 must not exec the unproven D or roll it back before trying it.
    await f.stage("4.0.0", "2.0.0");
    await f.command({ idle: true });
    const all = await f.wait((events) => residentHealthy(events, "2.0.0"));
    expect(all.filter((e) => e.type === "supervisor").map((e) => e.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(all.filter((e) => e.type === "child").map((e) => e.version)).toEqual([
      "1.0.0",
      "2.0.0",
      "4.0.0",
      "2.0.0",
      "2.0.0",
    ]);
    expect(await readUpdateRecord(f.binaryPath)).toMatchObject({
      state: "failed",
      version: "4.0.0",
      previousVersion: "2.0.0",
    });
  }, 10_000);
  test("an older supervisor hands over an already confirmed installation exactly once", async () => {
    const f = await start({}, true);
    const all = await f.wait((events) => residentHealthy(events, "2.0.0"));
    expect(all.filter((e) => e.type === "supervisor").map((e) => [e.version, e.pid])).toEqual([
      ["1.0.0", f.proc.pid],
      ["2.0.0", f.proc.pid],
    ]);
    await Bun.sleep(80);
    expect((await f.events()).filter((e) => e.type === "supervisor")).toHaveLength(2);
  }, 10_000);
  test("matching supervisor and child versions do not restart", async () => {
    const f = await start();
    await f.wait((all) => all.some((e) => e.type === "healthy"));
    await Bun.sleep(80);
    expect((await f.events()).map((e) => e.type)).toEqual(["supervisor", "child", "healthy"]);
  });
  test("execve failure keeps supervising instead of exiting or retrying in a loop", async () => {
    const f = await start({ CANOPY_TEST_EXECVE: "throws" });
    await f.wait((all) => all.some((e) => e.type === "healthy"));
    await f.stage("2.0.0", "1.0.0");
    await f.command({ restart: true });
    await f.wait(
      (all) =>
        all.some((e) => e.message?.includes("fixture execve failure")) &&
        all.some(
          (e, index) =>
            e.type === "stopped" &&
            e.exitCode === 76 &&
            all.slice(index + 1).some((next) => next.type === "healthy" && next.version === "2.0.0"),
        ),
    );
    await Bun.sleep(80);
    const all = await f.events();
    expect(all.filter((e) => e.type === "supervisor")).toHaveLength(1);
    expect(all.filter((e) => e.message?.includes("fixture execve failure"))).toHaveLength(1);
    expect(all.filter((e) => e.exitCode === 76)).toHaveLength(1);
    expect(f.proc.exitCode).toBeNull();
  }, 10_000);
});

describe("independent update service and gateway mirror", () => {
  test("exposes minimal health/version over HTTP/2 for a load balancer", async () => {
    const f = await fixture();
    const session = http2Connect(f.server.url);
    cleanups.push(() => session.destroy());
    const stream = session.request({ ":method": "GET", ":path": "/healthz" });
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (body += chunk));
    await new Promise<void>((resolve) => stream.on("end", resolve));
    expect(JSON.parse(body)).toEqual({ healthy: true, version: "2.0.0" });
  });
  test("refuses an old WorkerLink protocol but immediately sends compatibility and update commands over UpdateService", async () => {
    const f = await fixture();
    const old = { ...hello, minWorkerLinkProtocol: 0, workerLinkProtocol: 0 };
    await refused(
      openGatewayLink({ baseUrl: f.server.url, credential: "credential", hello: old }),
      Code.FailedPrecondition,
    );
    const anonymous = await f.client.check(old);
    expect(anonymous).toMatchObject({ healthy: true, version: "2.0.0", compatibility: "", reason: "" });
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const watch = f.client.watch(old, { headers, signal: abort.signal })[Symbol.asyncIterator]();
    expect((await watch.next()).value?.gateway?.compatibility).toBe("update_required");

    const command = create(update.UpdateCommandSchema, {
      id: "recover-old",
      version: "2.0.0",
      manifestJson: JSON.stringify(f.manifest),
      preferGatewayMirror: true,
    });

    f.service.push("worker", command);
    let next = await watch.next();

    while (!next.value?.command) next = await watch.next();
    expect(next.value.command).toMatchObject({ id: "recover-old", version: "2.0.0" });
    await refused(
      f.client.check({ ...old, workerId: "another-worker" }, { headers, timeoutMs: 1000 }),
      Code.Unauthenticated,
    );
    f.revoke();
    await refused(
      f.client.report(
        { workerId: "worker", commandId: command.id, state: "downloading" },
        { headers, timeoutMs: 1000 },
      ),
      Code.Unauthenticated,
    );
  });
  test("deduplicates mirror downloads, verifies the disk cache and repairs a corrupted cached binary", async () => {
    const f = await fixture();
    const paths = await Promise.all([f.mirror.artifact("linux", "x64"), f.mirror.artifact("linux", "x64")]);
    expect(paths[0]).toBe(paths[1]);
    expect(f.downloads()).toBe(1);
    await f.mirror.artifact("linux", "x64");
    expect(f.downloads()).toBe(1);
    await writeFile(paths[0]!, "x".repeat(Buffer.byteLength(f.bytes)));
    await f.mirror.artifact("linux", "x64");
    expect(f.downloads()).toBe(2);
    expect(await readFile(paths[0]!, "utf8")).toBe(f.bytes);
    const chunks: Uint8Array[] = [];

    for await (const chunk of f.client.fetchArtifact(
      { workerId: "worker", version: "2.0.0", os: "linux", arch: "x64" },
      { headers },
    ))
      chunks.push(chunk.data);
    expect(Buffer.concat(chunks).toString()).toBe(f.bytes);
    await refused(
      f.client
        .fetchArtifact({ workerId: "worker", version: "1.0.0", os: "linux", arch: "x64" }, { headers, timeoutMs: 1000 })
        [Symbol.asyncIterator]()
        .next(),
      Code.FailedPrecondition,
    );
  });
  test("worker downloads from gateway with no release internet access, waits for idle, restarts and reports persisted success", async () => {
    const f = await fixture(),
      binaryPath = join(f.dir, "worker");

    await writeFile(binaryPath, '#!/bin/sh\nprintf "1.0.0\\n"\n', { mode: 0o700 });

    let active = true,
      draining = false,
      restarted = false;

    const abort = new AbortController();
    cleanups.push(() => abort.abort());

    const worker = new WorkerUpdates({
      baseUrl: f.server.url,
      credential: "credential",
      workerId: "worker",
      version: "1.0.0",
      kind: "binary",
      binaryPath,
      signal: abort.signal,
      idle: () => !active,
      drain: (v) => (draining = v),
      restart: async () => {
        restarted = true;
      },
    });

    const command = create(update.UpdateCommandSchema, {
      id: "mirror-update",
      version: "2.0.0",
      manifestJson: JSON.stringify(f.manifest),
      preferGatewayMirror: true,
      maxIdleWaitSeconds: 10,
    });

    const updatePromise = worker.apply(command);

    for (let i = 0; i < 100 && !f.reports.some((r) => r.state === "waiting_idle"); i++) await Bun.sleep(10);
    expect(draining).toBe(true);
    expect(restarted).toBe(false);
    expect(f.downloads()).toBe(0);
    active = false;
    await updatePromise;
    expect(restarted).toBe(true);
    expect(f.downloads()).toBe(1);
    expect(await readFile(binaryPath, "utf8")).toBe(f.bytes);
    expect(f.reports.map((r) => r.state)).toEqual(["waiting_idle", "downloading", "restarting"]);
    await confirmStartup(binaryPath, "2.0.0");

    const next = new WorkerUpdates({
      baseUrl: f.server.url,
      credential: "credential",
      workerId: "worker",
      version: "2.0.0",
      kind: "binary",
      binaryPath,
      signal: abort.signal,
      idle: () => true,
      drain: () => {},
      restart: async () => {},
    });

    const run = next.run();

    for (let i = 0; i < 100 && !f.reports.some((r) => r.state === "succeeded"); i++) await Bun.sleep(10);
    abort.abort();
    await run;
    expect(f.reports.at(-1)?.state).toBe("succeeded");
    expect(await readUpdateRecord(binaryPath)).toBeUndefined();
  });
  test("docker workers report external management and do not download or restart", async () => {
    const f = await fixture();
    let restarted = false;

    const worker = new WorkerUpdates({
      baseUrl: f.server.url,
      credential: "credential",
      workerId: "worker",
      kind: "docker",
      version: "1.0.0",
      signal: new AbortController().signal,
      idle: () => true,
      drain: () => {},
      restart: async () => {
        restarted = true;
      },
    });

    await worker.apply(create(update.UpdateCommandSchema, { id: "external", version: "2.0.0" }));
    expect(f.reports[0]).toMatchObject({ state: "managed_externally", reason: expect.stringContaining("image tag") });
    expect(restarted).toBe(false);
    expect(f.downloads()).toBe(0);
  });
  test("worker rejects a mirror stream whose SHA differs from the command and keeps its executable", async () => {
    const f = await fixture(),
      binaryPath = join(f.dir, "worker");

    const old = '#!/bin/sh\nprintf "1.0.0\\n"\n';
    await writeFile(binaryPath, old, { mode: 0o700 });
    const manifest = structuredClone(f.manifest);
    manifest.assets[0]!.sha256 = "0".repeat(64);

    let restarted = false,
      draining = false;

    const worker = new WorkerUpdates({
      baseUrl: f.server.url,
      credential: "credential",
      workerId: "worker",
      kind: "binary",
      version: "1.0.0",
      binaryPath,
      signal: new AbortController().signal,
      idle: () => true,
      drain: (v) => (draining = v),
      restart: async () => {
        restarted = true;
      },
    });

    const error = await worker
      .apply(
        create(update.UpdateCommandSchema, {
          id: "bad-sha",
          version: "2.0.0",
          manifestJson: JSON.stringify(manifest),
          preferGatewayMirror: true,
        }),
      )
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(String(error)).toContain("SHA-256");
    expect(f.reports.at(-1)).toMatchObject({ state: "failed", reason: expect.stringContaining("SHA-256") });
    expect(await readFile(binaryPath, "utf8")).toBe(old);
    expect(restarted).toBe(false);
    expect(draining).toBe(false);
  });
  test("a restarted gateway replaces an obsolete queued version through the independent channel", async () => {
    const f = await fixture();
    let queued = create(update.UpdateCommandSchema, { id: "obsolete", version: "1.5.0" });

    const worker: WorkerUpdateRow = {
      id: "worker",
      name: "old",
      version: "1.0.0",
      os: "linux",
      arch: "x64",
      status: { installKind: "binary", state: "queued" },
      command: queued,
    };

    const runtime = new GatewayUpdates({
      cacheDir: join(f.dir, "restarted-cache"),
      version: "2.0.0",
      kind: "binary",
      source: f.mirror.source.options,
      authenticate: async () => "worker",
      persistence: {
        admin: async () => true,
        channel: async () => undefined,
        setChannel: async () => {},
        workers: async () => [worker],
        hello: async () => {},
        saveCommand: async (_id, command) => {
          queued = command;
        },
        report: async () => {},
      },
    });

    const server = await startGrpcServer({ routes: runtime.service.routes });
    cleanups.push(async () => {
      runtime.close();
      await server.close(50);
    });
    const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: server.url }));
    const abort = new AbortController();
    cleanups.push(() => abort.abort());

    const events = client
      .watch({ ...hello, minWorkerLinkProtocol: 0, workerLinkProtocol: 0 }, { headers, signal: abort.signal })
      [Symbol.asyncIterator]();

    expect((await events.next()).value?.gateway?.compatibility).toBe("update_required");
    expect(queued.version).toBe("1.5.0"); // No worker commands before gateway readiness.
    await runtime.start();
    let event = await events.next();

    while (!event.value?.command) event = await events.next();
    expect(event.value.command.version).toBe("2.0.0");
    expect(queued.version).toBe("2.0.0");
  });
  test("a newer worker is shown as ahead and never downgraded; desktop workers are managed by the app", async () => {
    const f = await fixture();

    const workers: WorkerUpdateRow[] = [
      { id: "ahead", name: "laptop", version: "2.1.0", os: "darwin", arch: "arm64", status: { installKind: "binary" } },
      {
        id: "desktop",
        name: "desktop",
        version: "1.0.0",
        os: "darwin",
        arch: "arm64",
        status: { installKind: "desktop" },
      },
    ];

    let saved = 0;

    const runtime = new GatewayUpdates({
      cacheDir: join(f.dir, "ahead-cache"),
      version: "2.0.0",
      kind: "binary",
      source: f.mirror.source.options,
      authenticate: async () => "worker",
      persistence: {
        admin: async () => true,
        channel: async () => undefined,
        setChannel: async () => {},
        workers: async () => workers,
        hello: async () => {},
        saveCommand: async () => {
          saved++;
        },
        report: async () => {},
      },
    });

    cleanups.push(() => runtime.close());
    await runtime.start();
    const snapshot = await runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "all" }));
    expect(saved).toBe(0);
    expect(snapshot.workers.find((w) => w.workerId === "ahead")).toMatchObject({
      state: "ahead",
      reason: expect.stringContaining("2.1.0"),
    });
    expect(snapshot.workers.find((w) => w.workerId === "desktop")).toMatchObject({
      state: "managed_externally",
      reason: expect.stringContaining("desktop app"),
    });
    await expect(
      runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "worker", workerId: "ahead" })),
    ).rejects.toThrow("downgrade");
  });
  test("admin gateway update waits for idle, preserves its release mirror and only then restarts", async () => {
    const f = await fixture(),
      binaryPath = join(f.dir, "gateway");

    await writeFile(binaryPath, '#!/bin/sh\nprintf "1.0.0\\n"\n', { mode: 0o700 });

    let admin = false,
      active = true,
      restarted = false;

    const workers: WorkerUpdateRow[] = [
      { id: "worker", name: "private", version: "1.0.0", os: "linux", arch: "x64", status: { installKind: "binary" } },
    ];

    const runtime = new GatewayUpdates({
      cacheDir: join(f.dir, "gateway-cache"),
      version: "1.0.0",
      kind: "binary",
      binaryPath,
      source: f.mirror.source.options,
      channel: "v2.0.0",
      authenticate: async () => "worker",
      idle: async () => !active,
      restart: async () => {
        restarted = true;
      },
      persistence: {
        admin: async () => admin,
        channel: async () => undefined,
        setChannel: async () => {},
        workers: async () => workers,
        hello: async () => {},
        saveCommand: async () => {},
        report: async () => {},
      },
    });

    cleanups.push(() => runtime.close());
    await runtime.start();
    await runtime.check();
    await refused(runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "gateway" })), Code.PermissionDenied);
    admin = true;
    await runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "gateway" }));
    expect(runtime.draining).toBe(true);
    expect(restarted).toBe(false);
    expect(f.downloads()).toBe(0);
    // Workers are still aligned to the running gateway; v2 is never queued ahead of it.
    await runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "all" }));
    expect(workers[0]?.command).toBeUndefined();
    active = false;

    for (let i = 0; i < 250 && !restarted; i++) await Bun.sleep(10);
    expect(restarted).toBe(true);
    expect(await readFile(binaryPath, "utf8")).toBe(f.bytes);

    const offlineSource = new ReleaseSource({
      fetch: async () => {
        throw new Error("offline");
      },
    });

    const afterRestart = new ReleaseMirror(join(f.dir, "gateway-cache"), "2.0.0", offlineSource);
    expect(await readFile(await afterRestart.artifact("linux", "x64"), "utf8")).toBe(f.bytes);
    expect(await afterRestart.manifest()).toEqual(f.manifest);
    const next = new GatewayUpdates({ ...runtime.options, version: "2.0.0" });
    cleanups.push(() => next.close());
    await next.start();
    expect((await next.snapshot()).gatewayState).toBe("succeeded");
    expect(await readUpdateRecord(binaryPath)).toMatchObject({ state: "succeeded" });
  });
});
