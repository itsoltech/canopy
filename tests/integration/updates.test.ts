import { afterEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { connect as http2Connect } from "node:http2";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ui, update } from "@open-agents/contracts";
import { createWorkerLink } from "@open-agents/gateway/worker-link";
import { openGatewayLink } from "@open-agents/worker/gateway-link";
import { createGrpcClientTransport, startGrpcServer } from "@open-agents/transport";
import { ReleaseMirror, ReleaseSource, confirmStartup, readUpdateRecord, type ReleaseManifest } from "../../packages/updater/src/index.ts";
import { GatewayUpdateService } from "../../apps/gateway/src/updates/service.ts";
import { WorkerUpdates } from "../../apps/worker/src/update-link.ts";
import { GatewayUpdates } from "../../apps/gateway/src/updates/runtime.ts";
import type { WorkerUpdateRow } from "../../apps/gateway/src/updates/persistence.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const headers = { authorization: "Bearer credential" };
const hello = { workerId: "worker", version: "1.0.0", minWorkerLinkProtocol: 1, workerLinkProtocol: 1, os: "linux", arch: "x64", installKind: "binary" };
async function refused(promise: Promise<unknown>, code: Code): Promise<void> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConnectError);
  expect((error as ConnectError).code).toBe(code);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "oa-update-integration-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let downloads = 0;
  const bytes = '#!/bin/sh\nprintf "2.0.0\\n"\n';
  const sha = createHash("sha256").update(bytes).digest("hex");
  const manifest: ReleaseManifest = { schema: 1, version: "2.0.0", channel: "v2.0.0", commit: "abcdef0", published_at: "2026-11-03T00:00:00Z",
    protocol: { worker_link: 1, update: 1 }, assets: ["worker", "gateway"].map((app) => ({ app: app as "worker" | "gateway", os: "linux", arch: "x64", name: `canopy-${app}-linux-x64`, url: "https://release.fixture/binary", sha256: sha, size: Buffer.byteLength(bytes) })) };
  const upstream = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/releases/tags/2.0.0") return Response.json({ tag_name: "2.0.0", draft: false, prerelease: false, assets: [{ name: "manifest.json", browser_download_url: "https://release.fixture/manifest" }] });
    if (path === "/manifest") return Response.json(manifest);
    if (path === "/binary") { downloads++; return new Response(bytes); }
    return new Response("not found", { status: 404 });
  } }); cleanups.push(() => { upstream.stop(true); });
  const source = new ReleaseSource({ baseUrl: "https://release.fixture", fetch: (input, init) => fetch(new URL(new URL(String(input)).pathname, upstream.url), init) });
  const mirror = new ReleaseMirror(join(dir, "cache"), "2.0.0", source);
  const reports: update.ReportRequest[] = [];
  let valid = true;
  const service = new GatewayUpdateService({ version: "2.0.0", mirror, authenticate: async (credential) => valid && credential === "credential" ? "worker" : undefined,
    hello: async () => {}, command: async () => undefined, report: async (_id, report) => { reports.push(report); }, authIntervalMs: 20 });
  const link = createWorkerLink({ authenticate: service.options.authenticate, welcome: async () => ({ heartbeatIntervalSeconds: 15 }) });
  const server = await startGrpcServer({ routes: (router) => { link.routes(router); service.routes(router); }, health: () => ({ healthy: true, version: "2.0.0" }) });
  cleanups.push(async () => { service.close(); await link.shutdown(); await server.close(50); });
  const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: server.url }));
  return { dir, bytes, manifest, mirror, reports, service, server, client, downloads: () => downloads, revoke: () => { valid = false; service.disconnect("worker"); } };
}

describe("independent update service and gateway mirror", () => {
  test("exposes minimal health/version over HTTP/2 for a load balancer", async () => {
    const f = await fixture();
    const session = http2Connect(f.server.url); cleanups.push(() => session.destroy());
    const stream = session.request({ ":method": "GET", ":path": "/healthz" });
    let body = "";
    stream.setEncoding("utf8"); stream.on("data", (chunk) => body += chunk);
    await new Promise<void>((resolve) => stream.on("end", resolve));
    expect(JSON.parse(body)).toEqual({ healthy: true, version: "2.0.0" });
  });
  test("refuses an old WorkerLink protocol but immediately sends compatibility and update commands over UpdateService", async () => {
    const f = await fixture();
    const old = { ...hello, minWorkerLinkProtocol: 0, workerLinkProtocol: 0 };
    await refused(openGatewayLink({ baseUrl: f.server.url, credential: "credential", hello: old }), Code.FailedPrecondition);
    const anonymous = await f.client.check(old);
    expect(anonymous).toMatchObject({ healthy: true, version: "2.0.0", compatibility: "", reason: "" });
    const abort = new AbortController(); cleanups.push(() => abort.abort());
    const watch = f.client.watch(old, { headers, signal: abort.signal })[Symbol.asyncIterator]();
    expect((await watch.next()).value?.gateway?.compatibility).toBe("update_required");
    const command = create(update.UpdateCommandSchema, { id: "recover-old", version: "2.0.0", manifestJson: JSON.stringify(f.manifest), preferGatewayMirror: true });
    f.service.push("worker", command);
    let next = await watch.next();
    while (!next.value?.command) next = await watch.next();
    expect(next.value.command).toMatchObject({ id: "recover-old", version: "2.0.0" });
    await refused(f.client.check({ ...old, workerId: "another-worker" }, { headers, timeoutMs: 1000 }), Code.Unauthenticated);
    f.revoke();
    await refused(f.client.report({ workerId: "worker", commandId: command.id, state: "downloading" }, { headers, timeoutMs: 1000 }), Code.Unauthenticated);
  });
  test("deduplicates mirror downloads, verifies the disk cache and repairs a corrupted cached binary", async () => {
    const f = await fixture();
    const paths = await Promise.all([f.mirror.artifact("linux", "x64"), f.mirror.artifact("linux", "x64")]);
    expect(paths[0]).toBe(paths[1]); expect(f.downloads()).toBe(1);
    await f.mirror.artifact("linux", "x64"); expect(f.downloads()).toBe(1);
    await writeFile(paths[0]!, "x".repeat(Buffer.byteLength(f.bytes)));
    await f.mirror.artifact("linux", "x64"); expect(f.downloads()).toBe(2);
    expect(await readFile(paths[0]!, "utf8")).toBe(f.bytes);
    const chunks: Uint8Array[] = [];
    for await (const chunk of f.client.fetchArtifact({ workerId: "worker", version: "2.0.0", os: "linux", arch: "x64" }, { headers })) chunks.push(chunk.data);
    expect(Buffer.concat(chunks).toString()).toBe(f.bytes);
    await refused(f.client.fetchArtifact({ workerId: "worker", version: "1.0.0", os: "linux", arch: "x64" }, { headers, timeoutMs: 1000 })[Symbol.asyncIterator]().next(), Code.FailedPrecondition);
  });
  test("worker downloads from gateway with no release internet access, waits for idle, restarts and reports persisted success", async () => {
    const f = await fixture(), binaryPath = join(f.dir, "worker");
    await writeFile(binaryPath, '#!/bin/sh\nprintf "1.0.0\\n"\n', { mode: 0o700 });
    let active = true, draining = false, restarted = false;
    const abort = new AbortController(); cleanups.push(() => abort.abort());
    const worker = new WorkerUpdates({ baseUrl: f.server.url, credential: "credential", workerId: "worker", version: "1.0.0", kind: "binary", binaryPath,
      signal: abort.signal, idle: () => !active, drain: (v) => draining = v, restart: async () => { restarted = true; } });
    const command = create(update.UpdateCommandSchema, { id: "mirror-update", version: "2.0.0", manifestJson: JSON.stringify(f.manifest), preferGatewayMirror: true, maxIdleWaitSeconds: 10 });
    const updatePromise = worker.apply(command);
    for (let i = 0; i < 100 && !f.reports.some((r) => r.state === "waiting_idle"); i++) await Bun.sleep(10);
    expect(draining).toBe(true); expect(restarted).toBe(false); expect(f.downloads()).toBe(0);
    active = false; await updatePromise;
    expect(restarted).toBe(true); expect(f.downloads()).toBe(1);
    expect(await readFile(binaryPath, "utf8")).toBe(f.bytes);
    expect(f.reports.map((r) => r.state)).toEqual(["waiting_idle", "downloading", "restarting"]);
    await confirmStartup(binaryPath, "2.0.0");
    const next = new WorkerUpdates({ baseUrl: f.server.url, credential: "credential", workerId: "worker", version: "2.0.0", kind: "binary", binaryPath,
      signal: abort.signal, idle: () => true, drain: () => {}, restart: async () => {} });
    const run = next.run();
    for (let i = 0; i < 100 && !f.reports.some((r) => r.state === "succeeded"); i++) await Bun.sleep(10);
    abort.abort(); await run;
    expect(f.reports.at(-1)?.state).toBe("succeeded");
    expect(await readUpdateRecord(binaryPath)).toBeUndefined();
  });
  test("docker workers report external management and do not download or restart", async () => {
    const f = await fixture(); let restarted = false;
    const worker = new WorkerUpdates({ baseUrl: f.server.url, credential: "credential", workerId: "worker", kind: "docker", version: "1.0.0", signal: new AbortController().signal,
      idle: () => true, drain: () => {}, restart: async () => { restarted = true; } });
    await worker.apply(create(update.UpdateCommandSchema, { id: "external", version: "2.0.0" }));
    expect(f.reports[0]).toMatchObject({ state: "managed_externally", reason: expect.stringContaining("image tag") });
    expect(restarted).toBe(false); expect(f.downloads()).toBe(0);
  });
  test("worker rejects a mirror stream whose SHA differs from the command and keeps its executable", async () => {
    const f = await fixture(), binaryPath = join(f.dir, "worker");
    const old = '#!/bin/sh\nprintf "1.0.0\\n"\n';
    await writeFile(binaryPath, old, { mode: 0o700 });
    const manifest = structuredClone(f.manifest); manifest.assets[0]!.sha256 = "0".repeat(64);
    let restarted = false, draining = false;
    const worker = new WorkerUpdates({ baseUrl: f.server.url, credential: "credential", workerId: "worker", kind: "binary", version: "1.0.0", binaryPath,
      signal: new AbortController().signal, idle: () => true, drain: (v) => draining = v, restart: async () => { restarted = true; } });
    const error = await worker.apply(create(update.UpdateCommandSchema, { id: "bad-sha", version: "2.0.0", manifestJson: JSON.stringify(manifest), preferGatewayMirror: true }))
      .then(() => undefined, (cause: unknown) => cause);
    expect(String(error)).toContain("SHA-256");
    expect(f.reports.at(-1)).toMatchObject({ state: "failed", reason: expect.stringContaining("SHA-256") });
    expect(await readFile(binaryPath, "utf8")).toBe(old); expect(restarted).toBe(false); expect(draining).toBe(false);
  });
  test("a restarted gateway replaces an obsolete queued version through the independent channel", async () => {
    const f = await fixture();
    let queued = create(update.UpdateCommandSchema, { id: "obsolete", version: "1.5.0" });
    const worker: WorkerUpdateRow = { id: "worker", name: "old", version: "1.0.0", os: "linux", arch: "x64", status: { installKind: "binary", state: "queued" }, command: queued };
    const runtime = new GatewayUpdates({ cacheDir: join(f.dir, "restarted-cache"), version: "2.0.0", kind: "binary", source: f.mirror.source.options,
      authenticate: async () => "worker", persistence: { admin: async () => true, channel: async () => undefined, setChannel: async () => {}, workers: async () => [worker],
        hello: async () => {}, saveCommand: async (_id, command) => { queued = command; }, report: async () => {} } });
    const server = await startGrpcServer({ routes: runtime.service.routes });
    cleanups.push(async () => { runtime.close(); await server.close(50); });
    const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: server.url }));
    const abort = new AbortController(); cleanups.push(() => abort.abort());
    const events = client.watch({ ...hello, minWorkerLinkProtocol: 0, workerLinkProtocol: 0 }, { headers, signal: abort.signal })[Symbol.asyncIterator]();
    expect((await events.next()).value?.gateway?.compatibility).toBe("update_required");
    expect(queued.version).toBe("1.5.0"); // No worker commands before gateway readiness.
    await runtime.start();
    let event = await events.next();
    while (!event.value?.command) event = await events.next();
    expect(event.value.command.version).toBe("2.0.0"); expect(queued.version).toBe("2.0.0");
  });
  test("admin gateway update waits for idle, preserves its release mirror and only then restarts", async () => {
    const f = await fixture(), binaryPath = join(f.dir, "gateway");
    await writeFile(binaryPath, '#!/bin/sh\nprintf "1.0.0\\n"\n', { mode: 0o700 });
    let admin = false, active = true, restarted = false;
    const workers: WorkerUpdateRow[] = [{ id: "worker", name: "private", version: "1.0.0", os: "linux", arch: "x64", status: { installKind: "binary" } }];
    const runtime = new GatewayUpdates({ cacheDir: join(f.dir, "gateway-cache"), version: "1.0.0", kind: "binary", binaryPath,
      source: f.mirror.source.options, channel: "v2.0.0", authenticate: async () => "worker", idle: async () => !active, restart: async () => { restarted = true; },
      persistence: { admin: async () => admin, channel: async () => undefined, setChannel: async () => {}, workers: async () => workers,
        hello: async () => {}, saveCommand: async () => {}, report: async () => {} } });
    cleanups.push(() => runtime.close());
    await runtime.start();
    await runtime.check();
    await refused(runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "gateway" })), Code.PermissionDenied);
    admin = true;
    await runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "gateway" }));
    expect(runtime.draining).toBe(true); expect(restarted).toBe(false); expect(f.downloads()).toBe(0);
    // Workers are still aligned to the running gateway; v2 is never queued ahead of it.
    await runtime.manage(create(ui.ManageUpdatesRequestSchema, { action: "all" }));
    expect(workers[0]?.command).toBeUndefined();
    active = false;
    for (let i = 0; i < 250 && !restarted; i++) await Bun.sleep(10);
    expect(restarted).toBe(true);
    expect(await readFile(binaryPath, "utf8")).toBe(f.bytes);
    const offlineSource = new ReleaseSource({ fetch: async () => { throw new Error("offline"); } });
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
