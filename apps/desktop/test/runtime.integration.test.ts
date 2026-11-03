import { expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tempDir } from "@canopy/testing";
import { DesktopRuntime, type RuntimePaths, type Secrets } from "../src/runtime/runtime.ts";
import { until } from "../src/runtime/process.ts";

const data = tempDir("canopy-desktop-local-");
const remoteData = tempDir("canopy-desktop-remote-");
const runtime = resolve(import.meta.dir, "../build/runtime");
const suffix = process.platform === "win32" ? ".exe" : "";
const paths: RuntimePaths = { bun: join(runtime, `bun${suffix}`), gateway: join(runtime, `canopy-gateway${suffix}`), worker: join(runtime, `canopy-worker${suffix}`), web: join(runtime, `canopy-web${suffix}`), postgres: join(runtime, "postgres"), compiled: true };
const secrets = (): Secrets => ({ databasePassword: randomBytes(32).toString("hex"), secretsKey: randomBytes(32).toString("base64"), serviceToken: randomBytes(32).toString("hex") });
function gone(pid: number) {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return false; } catch { return true; }
}

test.skipIf(!existsSync(paths.gateway))("bundled stack: local enrollment, gRPC online, remote enrollment, restart durability and complete shutdown", async () => {
  const keys = secrets();
  let local = new DesktopRuntime(data, paths, keys);
  const remote = new DesktopRuntime(remoteData, paths, secrets());
  const owned = new Set<number>();
  try {
    await local.initialize(false);
    await local.configure({ mode: "local", allowNetwork: false, bindHost: "127.0.0.1" });
    local.pids.forEach((pid) => owned.add(pid));
    expect(local.status.worker).toBe("online");
    expect(local.pids).toHaveLength(4);
    const api = local.client();
    const online = (await api.getOverview({})).workers;
    expect(online.filter((worker) => worker.online)).toHaveLength(1);
    const workerId = online[0]!.id;
    const project = (await api.createProject({ name: "Desktop persistence" })).project!;
    expect((await fetch(local.status.webUrl!)).ok).toBe(true);
    const token = (await api.createWorkerEnrollment({ name: "Remote desktop" })).token;
    await remote.initialize(false);
    await remote.configure({ mode: "remote", gatewayUrl: local.status.gatewayUrl!, webUrl: local.status.webUrl!, enrollmentToken: token });
    remote.pids.forEach((pid) => owned.add(pid));
    expect(remote.pids).toHaveLength(2); // worker and setup BFF; no gateway or DB
    expect((await api.getOverview({})).workers.filter((worker) => worker.online)).toHaveLength(2);
    const enrollment = await api.getWorkerSetup({});
    expect(enrollment.enrollments.filter((invite) => invite.usedAt)).toHaveLength(2);
    expect(readFileSync(join(remoteData, "desktop.json"), "utf8")).not.toContain(token);
    const logs = readdirSync(join(data, "logs")).map((name) => readFileSync(join(data, "logs", name), "utf8")).join("\n");
    for (const key of [...Object.values(keys), token]) expect(logs).not.toContain(key);
    await remote.stop();
    await local.stop();
    for (const pid of owned) expect(gone(pid)).toBe(true);
    local = new DesktopRuntime(data, paths, keys);
    await local.initialize();
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
    expect(Number(readFileSync(join(data, "postgres/data/postmaster.pid"), "utf8").split("\n")[0])).not.toBe(postgresPid);
  } finally {
    await remote.stop();
    await local.stop();
  }
  for (const pid of owned) expect(gone(pid)).toBe(true);
}, 180_000);

test.skipIf(!existsSync(paths.gateway))("guardian closes its owned process groups when the Electron pipe disappears", async () => {
  const directory = tempDir("canopy-desktop-guardian-");
  const child = spawn(join(runtime, `canopy-controller${suffix}`), [], { stdio: "pipe" });
  const exited = once(child, "exit");
  const replies = new Map<number, (message: { result?: { pids: number[] }; error?: string }) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id) replies.get(message.id)?.(message);
  });
  async function request(id: number, action: string, args: Record<string, unknown>) {
    const reply = new Promise<{ pids: number[] }>((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error("Guardian RPC timed out")), 90_000);
      replies.set(id, (message) => { clearTimeout(timer); replies.delete(id); message.error ? reject(new Error(message.error)) : resolveReply(message.result!); });
    });
    child.stdin.write(JSON.stringify({ id, action, ...args }) + "\n");
    return reply;
  }
  let pids: number[] = [];
  try {
    await request(1, "initialize", { directory, paths, secrets: secrets() });
    pids = (await request(2, "configure", { configuration: { mode: "local", allowNetwork: false, bindHost: "127.0.0.1" } })).pids;
    expect(pids).toHaveLength(4);
    child.stdin.destroy(); // Same EOF the guardian receives after an Electron crash.
    await exited;
    expect(child.exitCode).toBe(0);
    for (const pid of pids) expect(gone(pid)).toBe(true);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    lines.close();
  }
}, 120_000);

test.skipIf(!existsSync(paths.gateway))("a postmaster orphaned by a killed guardian is stopped on the next start, so only one runs", async () => {
  const directory = tempDir("canopy-desktop-orphan-");
  const keys = secrets();
  const guardian = () => {
    const child = spawn(join(runtime, `canopy-controller${suffix}`), [], { stdio: "pipe" });
    const replies = new Map<number, (message: { result?: { pids: number[] }; error?: string }) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => { const message = JSON.parse(line); if (message.id) replies.get(message.id)?.(message); });
    const request = (id: number, action: string, args: Record<string, unknown>) => new Promise<{ pids: number[] }>((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error("Guardian RPC timed out")), 90_000);
      replies.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolveReply(message.result!); });
      child.stdin.write(JSON.stringify({ id, action, ...args }) + "\n");
    });
    return { child, exited: once(child, "exit"), start: async () => { await request(1, "initialize", { directory, paths, secrets: keys }); return (await request(2, "configure", { configuration: { mode: "local", allowNetwork: false, bindHost: "127.0.0.1" } })).pids; } };
  };
  const postmaster = () => Number(readFileSync(join(directory, "postgres", "data", "postmaster.pid"), "utf8").split("\n")[0]);
  const first = guardian();
  await first.start();
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
}, 240_000);
