import { afterAll, expect, test } from "bun:test";
import { cpSync, copyFileSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { Result } from "effect";
import { ui } from "@canopy/contracts";
import { startGrpcServer } from "@canopy/transport";
import { generateIdentity } from "../../gateway/src/computers/identity.ts";
import { tempDir } from "@canopy/testing";
import { DesktopRuntime, type RuntimePaths, type Secrets } from "../src/runtime/runtime.ts";
import { controllerEntry, runtimePaths } from "../src/runtime/launch.ts";
import { until } from "../src/runtime/process.ts";
import { postgresArchive, postgresRegistry } from "./postgres-fixture.ts";
import { migrateDesktopClient } from "../src/client-migration.ts";
import { remoteWorkerDirectory, type DesktopClientCredential } from "../src/remote-client.ts";
import { parseLocalConfig } from "../../worker/src/config/local.ts";

const data = tempDir("canopy-desktop-local-");
const remoteData = tempDir("canopy-desktop-remote-");
const noWorkerData = tempDir("canopy-desktop-worker-unavailable-");
const source = process.env["CANOPY_DESKTOP_RUNTIME"] ?? resolve(import.meta.dir, "../build/runtime");
const runtime = tempDir("canopy-desktop-isolated-runtime-");
const available = existsSync(join(source, "canopy-gateway.js"));

if (available) cpSync(source, runtime, { recursive: true, dereference: false, verbatimSymlinks: true });

const fixture = postgresArchive(tempDir("canopy-desktop-postgres-registry-"));
const registry = await postgresRegistry(fixture.bytes);

afterAll(() => registry.close());

if (available) copyFileSync(fixture.manifest, join(runtime, "postgres.json"));

const guardianEnvironment = { ...process.env, NODE_ENV: "test", CANOPY_TEST_POSTGRES_REGISTRY: registry.registry };
const paths: RuntimePaths = runtimePaths(runtime);

const secrets = (): Secrets => ({
  databasePassword: randomBytes(32).toString("hex"),
  secretsKey: randomBytes(32).toString("base64"),
  serviceToken: randomBytes(32).toString("hex"),
});

// The window's own form action passes SvelteKit's CSRF origin check (a validation failure, not a 403); a foreign origin does not.
async function formAction(origin: string, from = origin) {
  const response = await fetch(`${origin}/?/createThread`, {
    method: "POST",
    headers: { origin: from, accept: "application/json", "x-sveltekit-action": "true" },
    body: new URLSearchParams({ projectId: "" }),
  });

  return { status: response.status, body: await response.text() };
}

function gone(pid: number) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);

    return false;
  } catch {
    return true;
  }
}

test.skipIf(!existsSync(paths.web))(
  "paired remote UI works without worker enrollment and unchanged saves preserve its processes",
  async () => {
    const directory = noWorkerData;
    const identity = await generateIdentity();

    const server = await startGrpcServer({
      tls: { cert: identity.certificate, key: identity.privateKey },
      routes: (router) =>
        router.service(ui.GatewayService, {
          getClientCapabilities: () => ({
            minProtocol: 1,
            maxProtocol: 1,
            methods: ui.GatewayService.methods.map((m) => m.name),
          }),
          getOverview: () => ({}),
          getSettings: () => ({}),
        }),
    });

    const desktop = new DesktopRuntime(directory, paths, secrets());

    const client: DesktopClientCredential = {
      token: "test-desktop-client",
      deviceId: "test-device",
      fingerprint: identity.fingerprint,
      addresses: ["https://127.0.0.1:1", server.url],
    };

    try {
      await desktop.initialize(false);
      await desktop.configure({ mode: "remote", gatewayUrl: server.url }, client);
      expect(desktop.status).toMatchObject({ phase: "running", worker: "offline", webUrl: desktop.origin });
      expect(desktop.pids).toHaveLength(0); // the UI and its BFF run in this process (runtime/web.ts)
      const pids = desktop.pids;
      const saved = statSync(join(directory, "desktop.json")).mtimeMs;
      const selected = desktop.status.configuration;

      if (selected?.mode !== "remote") throw new Error("Remote configuration was not saved");
      await desktop.configure({ ...selected, gatewayUrl: `${selected.gatewayUrl}/` }, client);
      await desktop.configure(selected);
      expect(desktop.pids).toEqual(pids);
      expect(statSync(join(directory, "desktop.json")).mtimeMs).toBe(saved);
      expect((await fetch(`${desktop.origin}/api/overview`)).ok).toBe(true);
      expect(existsSync(join(directory, "postgres"))).toBe(false);
    } finally {
      await desktop.stop();
      await server.close(0);
    }
  },
  30_000,
);

test.skipIf(!existsSync(paths.gateway))(
  "bundled stack: local enrollment, gRPC online, remote enrollment, restart durability and complete shutdown",
  async () => {
    const keys = secrets();
    let local = new DesktopRuntime(data, paths, keys, () => {}, registry);

    let remote = new DesktopRuntime(
      remoteData,
      { ...paths, postgres: "remote-must-not-read-postgres-manifest" },
      secrets(),
      () => {},
      registry,
    );

    const owned = new Set<number>();

    try {
      await local.initialize(false);
      expect(local.status).toMatchObject({ mode: null, phase: "setup" });
      await local.configure({ mode: "local", allowNetwork: false, bindHost: "127.0.0.1" });
      local.pids.forEach((pid) => owned.add(pid));
      expect(local.status.worker).toBe("online");
      expect(local.pids).toHaveLength(3); // PostgreSQL, gateway, worker; the web runs in this process
      const pidsBeforeSave = local.pids;
      const configBeforeSave = statSync(join(data, "desktop.json")).mtimeMs;
      await local.configure({ mode: "local", allowNetwork: false, bindHost: "127.0.0.1" });
      expect(local.pids).toEqual(pidsBeforeSave);
      expect(local.status.phase).toBe("running");
      expect(statSync(join(data, "desktop.json")).mtimeMs).toBe(configBeforeSave);
      const api = local.client();
      expect(await api.getClientCapabilities({})).toMatchObject({ gatewayRole: "desktop", linkedComputers: true });
      const online = (await api.getOverview({})).workers;
      expect(online.filter((worker) => worker.online)).toHaveLength(1);
      const workerId = online[0]!.id;
      const project = (await api.createProject({ name: "Desktop persistence" })).project!;
      expect((await fetch(local.status.webUrl!)).ok).toBe(true);
      expect((await formAction(local.status.webUrl!)).body).toContain("Choose a project");
      expect((await formAction(local.status.webUrl!, "http://attacker.example")).status).toBe(403);

      const token = (await api.createWorkerEnrollment({ name: "Remote desktop" })).token;
      await api.updateNetworkAccess({ action: "set_enabled", enabled: true });
      await remote.initialize(false);
      const beforeRemote = registry.ranges.length;
      const oldConfig = { mode: "remote" as const, gatewayUrl: local.status.gatewayUrl!, webUrl: local.status.webUrl! };
      writeFileSync(join(remoteData, "desktop.json"), JSON.stringify(oldConfig));
      await remote.configure({
        ...oldConfig,
        enrollmentToken: token,
      });
      expect(remote.status.needsPairing).toBe(true);
      await until(async () => (await api.getOverview({})).workers.filter((worker) => worker.online).length === 2);
      let client: DesktopClientCredential | undefined;
      await until(async () => {
        client = await migrateDesktopClient(remoteWorkerDirectory(remoteData, oldConfig));

        return Boolean(client);
      });
      const workerPath = join(remoteWorkerDirectory(remoteData, oldConfig), "worker.json");
      const readWorker = () => Result.getOrThrow(parseLocalConfig(readFileSync(workerPath, "utf8")));
      const workerBefore = readWorker();
      // Initial pairing restarts services. The worker may independently migrate to a pinned
      // Network access route, but must preserve its enrollment and durable data directory.
      await remote.configure(oldConfig, client);
      const workerAfter = readWorker();
      expect(
        workerAfter.worker_id === workerBefore.worker_id &&
          workerAfter.credential === workerBefore.credential &&
          workerAfter.data_dir === workerBefore.data_dir,
      ).toBe(true);
      await until(async () => Boolean(readWorker().gateway_fallback));
      const pairedConfig = remote.status.configuration!;
      const pairedPids = remote.pids;
      const savedAt = statSync(join(remoteData, "desktop.json")).mtimeMs;
      const migratedWorker = readFileSync(workerPath, "utf8");
      const workerSavedAt = statSync(workerPath).mtimeMs;
      await remote.configure(pairedConfig, client);
      expect(remote.pids).toEqual(pairedPids);
      expect(statSync(join(remoteData, "desktop.json")).mtimeMs).toBe(savedAt);
      expect(statSync(workerPath).mtimeMs).toBe(workerSavedAt);
      expect(readFileSync(workerPath, "utf8") === migratedWorker).toBe(true);
      expect(remote.status.webUrl).toBe(remote.origin);
      expect(remote.status.webUrl).not.toBe(local.status.webUrl);
      expect((await fetch(`${remote.origin}/api/overview`)).ok).toBe(true);
      expect(
        (await fetch(`${remote.origin}/api/overview`, { headers: { origin: "https://attacker.invalid" } })).status,
      ).toBe(403);
      expect((await fetch(`${remote.origin}/api/overview`, { headers: { host: "attacker.invalid" } })).status).toBe(
        403,
      );
      expect(registry.ranges.length).toBe(beforeRemote);
      expect(existsSync(join(remoteData, "postgres"))).toBe(false);
      remote.pids.forEach((pid) => owned.add(pid));
      expect(remote.pids).toHaveLength(1); // the worker; no gateway or DB, the frontend/BFF runs in this process
      await until(() => remote.drainWorker(true));
      expect(await remote.drainWorker(true)).toBe(true);
      await remote.drainWorker(false);
      expect((await formAction(remote.origin)).body).toContain("Choose a project");
      await until(async () => (await api.getOverview({})).workers.filter((worker) => worker.online).length === 2);
      expect((await api.getOverview({})).workers.filter((worker) => worker.online)).toHaveLength(2);
      const enrollment = await api.getWorkerSetup({});
      expect(enrollment.enrollments.filter((invite) => invite.usedAt)).toHaveLength(2);
      expect(readFileSync(join(remoteData, "desktop.json"), "utf8").includes(token)).toBe(false);

      const logs = readdirSync(join(data, "logs"))
        .map((name) => readFileSync(join(data, "logs", name), "utf8"))
        .join("\n");

      for (const key of [...Object.values(keys), token, client!.token]) expect(logs.includes(key)).toBe(false);
      expect(readFileSync(join(remoteData, "desktop.json"), "utf8").includes(client!.token)).toBe(false);
      await remote.stop();
      await local.stop();

      for (const pid of owned) expect(gone(pid)).toBe(true);
      local = new DesktopRuntime(data, paths, keys, () => {}, registry);
      registry.offline(true);
      await local.initialize(false);
      expect(local.status).toMatchObject({ mode: "local", phase: "starting" });
      await local.restore();
      registry.offline(false);
      expect(registry.ranges.length).toBe(beforeRemote);
      local.pids.forEach((pid) => owned.add(pid));
      const restarted = await local.client().getOverview({});
      expect(restarted.workers.find((worker) => worker.id === workerId)?.online).toBe(true);
      expect(restarted.projects.some((candidate) => candidate.id === project.id)).toBe(true);
      // Crash the tracked PostgreSQL parent: native stale PID validation and WAL recovery keep data.
      const postgresPid = Number(readFileSync(join(data, "postgres/data/postmaster.pid"), "utf8").split("\n")[0]);
      process.kill(postgresPid, "SIGKILL");
      await until(async () => {
        local.pids.forEach((pid) => owned.add(pid));

        return (await local.client().getOverview({})).projects.some((candidate) => candidate.id === project.id);
      }, 45_000);
      expect(Number(readFileSync(join(data, "postgres/data/postmaster.pid"), "utf8").split("\n")[0])).not.toBe(
        postgresPid,
      );

      // The UI is not a child of the gateway: while the gateway restarts, the shell keeps answering and the BFF
      // reports the gateway as unavailable until it is back.
      if (process.platform !== "win32") {
        const gatewayPid = local.pids.find((pid) =>
          Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)])
            .stdout.toString()
            .includes("canopy-gateway.js"),
        );

        process.kill(gatewayPid!, "SIGKILL");
        let shellAnswered = 0;
        await until(async () => {
          if ((await fetch(local.status.webUrl!)).ok) shellAnswered++;

          return (await fetch(`${local.status.webUrl}/api/overview`)).ok && shellAnswered > 0;
        }, 30_000);
        local.pids.forEach((pid) => owned.add(pid));
        expect(shellAnswered).toBeGreaterThan(0);
      }

      await local.stop();
      remote = new DesktopRuntime(remoteData, paths, secrets(), () => {}, registry);
      await remote.initialize(false);
      expect(remote.status).toMatchObject({ mode: "remote", phase: "starting" });
      const reconnectStarted = performance.now();
      await remote.restore(client);
      expect(remote.status.phase).toBe("running");
      expect(performance.now() - reconnectStarted).toBeLessThan(5000);
      expect(existsSync(join(remoteData, "postgres"))).toBe(false);
      expect((await fetch(`${remote.origin}/desktop`)).ok).toBe(true);
      expect((await fetch(remote.origin)).ok).toBe(true);
      expect((await fetch(`${remote.origin}/api/overview`)).status).toBe(503);
      remote.pids.forEach((pid) => owned.add(pid));
    } finally {
      registry.offline(false);
      await remote.stop();
      await local.stop();
    }

    for (const pid of owned) expect(gone(pid)).toBe(true);
  },
  180_000,
);

test.skipIf(!existsSync(paths.web))(
  "failed restoration preserves saved mode and configuration for startup recovery",
  async () => {
    const directory = tempDir("canopy-desktop-startup-failure-");
    const saved = JSON.stringify({ mode: "local", allowNetwork: false, bindHost: "127.0.0.1" });
    writeFileSync(join(directory, "desktop.json"), saved);

    const desktop = new DesktopRuntime(
      directory,
      { ...paths, postgres: join(directory, "missing-manifest") },
      secrets(),
    );

    try {
      await desktop.initialize(false);
      expect(desktop.status).toMatchObject({ mode: "local", phase: "starting" });
      await desktop.restore();
      expect(desktop.status).toMatchObject({ mode: "local", phase: "error", worker: "offline" });
      expect(desktop.status.error).toBeTruthy();
      expect(readFileSync(join(directory, "desktop.json"), "utf8")).toBe(saved);
      expect(desktop.pids).toHaveLength(0);
    } finally {
      await desktop.stop();
    }
  },
);

test.skipIf(!existsSync(paths.gateway))(
  "guardian closes its owned process groups when the Electron pipe disappears",
  async () => {
    const directory = tempDir("canopy-desktop-guardian-");
    const child = spawn(paths.bun, [controllerEntry(runtime)], { stdio: "pipe", env: guardianEnvironment });
    const exited = once(child, "exit");

    const replies = new Map<
      number,
      (message: { result?: { pids: number[]; origin?: string }; error?: string }) => void
    >();

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);

      if (message.id) replies.get(message.id)?.(message);
    });

    async function request(id: number, action: string, args: import("../src/controller.ts").ControllerArguments) {
      const reply = new Promise<{ pids: number[]; origin?: string }>((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error("Guardian RPC timed out")), 90_000);
        replies.set(id, (message) => {
          clearTimeout(timer);
          replies.delete(id);

          if (message.error) reject(new Error(message.error));
          else resolveReply(message.result!);
        });
      });

      child.stdin.write(JSON.stringify({ id, action, ...args }) + "\n");

      return reply;
    }

    let pids: number[] = [];

    try {
      const { origin } = await request(1, "initialize", { directory, paths, secrets: secrets() });
      // The web runs in the controller: the BFF logs this failed gateway call, which must go to the `web` log and
      // never onto stdout, the protocol pipe the next replies come through.
      expect((await fetch(`${origin}/api/overview`)).ok).toBe(false);
      pids = (
        await request(2, "configure", { configuration: { mode: "local", allowNetwork: false, bindHost: "127.0.0.1" } })
      ).pids;
      expect(pids).toHaveLength(3);
      expect(readFileSync(join(directory, "logs", "web.log"), "utf8")).toContain("gateway call failed");
      const savedAt = statSync(join(directory, "desktop.json")).mtimeMs;
      expect((await request(3, "configure", { configuration: { mode: "local" } })).pids).toEqual(pids);
      expect(statSync(join(directory, "desktop.json")).mtimeMs).toBe(savedAt);
      child.stdin.destroy(); // Same EOF the guardian receives after an Electron crash.
      await exited;
      expect(child.exitCode).toBe(0);

      for (const pid of pids) expect(gone(pid)).toBe(true);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exited;
      }

      lines.close();
    }
  },
  120_000,
);

test.skipIf(!existsSync(paths.gateway))(
  "a postmaster orphaned by a killed guardian is stopped on the next start, so only one runs",
  async () => {
    const directory = tempDir("canopy-desktop-orphan-");
    const keys = secrets();

    const guardian = () => {
      const child = spawn(paths.bun, [controllerEntry(runtime)], { stdio: "pipe", env: guardianEnvironment });
      const replies = new Map<number, (message: { result?: { pids: number[] }; error?: string }) => void>();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const message = JSON.parse(line);

        if (message.id) replies.get(message.id)?.(message);
      });

      const request = (id: number, action: string, args: import("../src/controller.ts").ControllerArguments) =>
        new Promise<{ pids: number[] }>((resolveReply, reject) => {
          const timer = setTimeout(() => reject(new Error("Guardian RPC timed out")), 90_000);
          replies.set(id, (message) => {
            clearTimeout(timer);

            if (message.error) reject(new Error(message.error));
            else resolveReply(message.result!);
          });
          child.stdin.write(JSON.stringify({ id, action, ...args }) + "\n");
        });

      return {
        child,
        exited: once(child, "exit"),
        start: async () => {
          await request(1, "initialize", { directory, paths, secrets: keys });

          return (
            await request(2, "configure", {
              configuration: { mode: "local", allowNetwork: false, bindHost: "127.0.0.1" },
            })
          ).pids;
        },
      };
    };

    const postmaster = () =>
      Number(readFileSync(join(directory, "postgres", "data", "postmaster.pid"), "utf8").split("\n")[0]);

    const first = guardian();
    const orphaned = await first.start();
    const orphan = postmaster();
    first.child.kill("SIGKILL"); // kill -9 / OOM: no cleanup code runs in the guardian.
    await first.exited;
    expect(gone(orphan)).toBe(false); // postgres does not watch its parent: it survives until the next start.
    const second = guardian();
    let current = 0;

    try {
      const pids = await second.start();
      current = postmaster();
      expect(gone(orphan)).toBe(true);
      expect(pids).toContain(current);
    } finally {
      second.child.stdin.end();
      await second.exited;
    }

    // A clean quit stops it and removes the lock.
    expect(gone(current)).toBe(true);
    expect(existsSync(join(directory, "postgres", "data", "postmaster.pid"))).toBe(false);
    // The killed guardian's other sidecars stop on their own (stdin EOF), and none keeps writing to its data.
    await until(async () => orphaned.every(gone), 30_000);
  },
  240_000,
);
