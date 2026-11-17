import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { z } from "zod";
import { DeviceBootNotStartedError, DevicePool, type Device, type DevicePoolBackend } from "./device-pool.ts";

const makeDir = tempDirs();
const pools: DevicePool[] = [];
const signal = () => new AbortController().signal;
const journalSchema = z.array(z.object({ key: z.string(), session: z.string(), device: z.object({ id: z.string() }) }));

function deferred() {
  let resolve = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function device(id: string, booted = false, kind: Device["kind"] = "emulator"): Device {
  return { id, name: `Device ${id}`, booted, kind, platform: "android" };
}

class Backend implements DevicePoolBackend {
  inventory: Device[];
  calls: string[] = [];
  bootGate = Promise.resolve();
  shutdownGate = Promise.resolve();
  bootFailure = false;
  preflightFailure = false;
  shutdownFailure = false;
  closeFailure = false;
  runtimeIds = false;
  onBoot: (() => void) | undefined;
  listGate = Promise.resolve();

  constructor(devices: Device[]) {
    this.inventory = devices;
  }

  async devices(_signal: AbortSignal): Promise<Device[]> {
    this.calls.push("devices");
    await this.listGate;

    return this.inventory.map((entry) => ({ ...entry }));
  }

  async boot(entry: Device, _signal: AbortSignal): Promise<Device> {
    this.calls.push(`boot:${entry.id}`);
    this.onBoot?.();

    if (this.preflightFailure) throw new DeviceBootNotStartedError("Externally booted before dispatch");
    await this.bootGate;
    const running = { ...entry, id: this.runtimeIds ? `runtime-${entry.id}` : entry.id, booted: true };
    this.inventory = this.inventory.map((item) => (item.id === entry.id ? running : item));

    if (this.bootFailure) throw new Error("Boot failed after starting native device");

    return running;
  }

  async closeSession(session: string): Promise<void> {
    this.calls.push(`close:${session}`);

    if (this.closeFailure) throw new Error("Session cleanup failed");
  }

  async shutdown(entry: Device, _signal: AbortSignal): Promise<void> {
    this.calls.push(`shutdown:${entry.id}`);
    await this.shutdownGate;

    if (this.shutdownFailure) throw new Error("Native shutdown failed");
    this.inventory = this.inventory.map((item) => (item.id === entry.id ? { ...item, booted: false } : item));
  }
}

function fixture(devices: Device[], idleMs = 60_000) {
  const dataDir = makeDir("canopy-device-pool-");
  const backend = new Backend(devices);
  const pool = new DevicePool({ dataDir, backend, idleMs });
  pools.push(pool);
  const journal = () => journalSchema.parse(JSON.parse(readFileSync(join(dataDir, "device-pool.json"), "utf8")));

  return { pool, backend, dataDir, journal };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Device pool test timed out");
    await Bun.sleep(2);
  }
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((pool) => pool.close()));
});

test("free booted devices are preferred; external and physical devices are never stopped", async () => {
  const { pool, backend } = fixture([device("stopped"), device("external", true), device("phone", true, "device")]);
  expect((await pool.acquire("one", { boot: true }, signal())).id).toBe("external");
  expect((await pool.acquire("two", { boot: true }, signal())).id).toBe("phone");
  await Promise.all([pool.release("one"), pool.release("two")]);
  expect(backend.calls.filter((call) => call.startsWith("boot:") || call.startsWith("shutdown:"))).toEqual([]);
  expect(backend.calls).toContain("close:one");
  expect(backend.calls).toContain("close:two");
});

test("Preview excludes pending and releasing reservations and follows the owned runtime identity", async () => {
  const { pool, backend } = fixture([device("avd"), device("free", true)]);
  const boot = deferred();
  backend.bootGate = boot.promise;
  backend.runtimeIds = true;
  const acquiring = pool.acquire("thread", { deviceId: "avd", boot: true }, signal());
  await until(() => backend.calls.includes("boot:avd"));
  expect(pool.canPreview("thread", "free", "android")).toBe(false);
  expect(pool.canPreview("another", "avd", "android")).toBe(false);
  boot.resolve();
  await acquiring;
  expect(pool.canPreview("thread", "runtime-avd", "android")).toBe(true);
  expect(pool.canPreview("thread", "free", "android")).toBe(false);
  expect(pool.canPreview("another", "runtime-avd", "android")).toBe(false);
  const shutdown = deferred();
  backend.shutdownGate = shutdown.promise;
  const releasing = pool.release("thread");
  await until(() => backend.calls.includes("shutdown:runtime-avd"));
  expect(pool.canPreview("thread", "free", "android")).toBe(false);
  expect(pool.canPreview("another", "runtime-avd", "android")).toBe(false);
  shutdown.resolve();
  await releasing;
  expect(pool.canPreview("thread", "free", "android")).toBe(true);
});

test("session reacquisition is idempotent, validates selectors and does not expose mutable lease state", async () => {
  const { pool, backend } = fixture([device("one", true), device("two", true)]);
  const first = await pool.acquire("thread", { deviceId: "Device one" }, signal());
  first.id = "mutated";
  expect((await pool.acquire("thread", {}, signal())).id).toBe("one");
  expect((await pool.acquire("thread", { deviceId: "one" }, signal())).id).toBe("one");
  await expect(pool.acquire("thread", { deviceId: "two" }, signal())).rejects.toThrow("different device");
  await expect(pool.acquire("thread", { platform: "ios" }, signal())).rejects.toThrow("different device");
  expect(backend.calls.filter((call) => call === "devices")).toHaveLength(1);
});

test("simultaneous reservations never boot or lease the same device twice", async () => {
  const { pool, backend } = fixture([device("one")]);
  const gate = deferred();
  backend.bootGate = gate.promise;
  const one = pool.acquire("one", { boot: true }, signal());
  await until(() => backend.calls.includes("boot:one"));
  const two = pool.acquire("two", { boot: true, timeoutMs: 50 }, signal()).catch((error: Error) => error);
  gate.resolve();
  expect((await one).id).toBe("one");
  expect(await two).toBeInstanceOf(Error);
  expect(backend.calls.filter((call) => call === "boot:one")).toHaveLength(1);
});

test("parallel same-session acquisitions share the reservation and boot", async () => {
  const { pool, backend } = fixture([device("one")]);

  const results = await Promise.all([
    pool.acquire("thread", { boot: true }, signal()),
    pool.acquire("thread", { boot: true }, signal()),
  ]);

  expect(results.map((entry) => entry.id)).toEqual(["one", "one"]);
  expect(backend.calls.filter((call) => call === "boot:one")).toHaveLength(1);
});

test("two owned virtual devices limit concurrent boots while external booted devices remain available", async () => {
  const { pool, backend } = fixture([device("one"), device("two"), device("three"), device("external", true)]);
  const gate = deferred();
  backend.bootGate = gate.promise;
  const one = pool.acquire("one", { deviceId: "one", boot: true }, signal());
  const two = pool.acquire("two", { deviceId: "two", boot: true }, signal());
  await until(() => backend.calls.includes("boot:one") && backend.calls.includes("boot:two"));
  const waiting = pool.acquire("three", { deviceId: "three", boot: true, timeoutMs: 1_000 }, signal());
  expect((await pool.acquire("external", { deviceId: "external" }, signal())).id).toBe("external");
  expect(backend.calls).not.toContain("boot:three");
  gate.resolve();
  await Promise.all([one, two]);
  await pool.release("one");
  expect((await waiting).id).toBe("three");
  expect(backend.calls.indexOf("shutdown:one")).toBeLessThan(backend.calls.indexOf("boot:three"));
});

test("a contending wait is cancellable and never blocks release or other leases", async () => {
  const { pool } = fixture([device("one", true), device("two", true)]);
  await pool.acquire("owner", { deviceId: "one" }, signal());
  const controller = new AbortController();
  const waiting = pool.acquire("waiter", { deviceId: "one" }, controller.signal).catch((error: Error) => error);
  expect((await pool.acquire("other", { deviceId: "two" }, signal())).id).toBe("two");
  controller.abort(new Error("Cancelled acquisition"));
  expect(await waiting).toMatchObject({ message: "Cancelled acquisition" });
  await pool.release("owner");
  expect((await pool.acquire("next", { deviceId: "one", timeoutMs: 100 }, signal())).id).toBe("one");
});

test("release wakes a waiting acquisition without waiting for external inventory polling", async () => {
  const { pool, backend } = fixture([device("one", true)]);
  await pool.acquire("owner", {}, signal());
  const count = backend.calls.length;
  const waiting = pool.acquire("waiter", { timeoutMs: 250 }, signal());
  await until(() => backend.calls.length > count);
  await pool.release("owner");
  expect((await waiting).id).toBe("one");
});

test("no configured match fails immediately; busy devices respect wait:false and boot:false", async () => {
  const busy = { ...device("busy", true), busy: true };
  const { pool, backend } = fixture([busy, device("stopped"), device("phone", false, "device")]);
  await expect(pool.acquire("missing", { deviceId: "missing" }, signal())).rejects.toThrow("No configured");
  await expect(pool.acquire("busy", { deviceId: "busy", wait: false }, signal())).rejects.toThrow("available");
  await expect(pool.acquire("stopped", { deviceId: "stopped", wait: false }, signal())).rejects.toThrow("available");
  await expect(pool.acquire("phone", { deviceId: "phone", boot: true, wait: false }, signal())).rejects.toThrow(
    "available",
  );
  expect(backend.calls.filter((call) => call.startsWith("boot:"))).toEqual([]);
});

test("wait:false permits inventory completion and does not cancel native discovery immediately", async () => {
  const { pool, backend } = fixture([device("one", true)]);
  const gate = deferred();
  backend.listGate = gate.promise;
  const acquisition = pool.acquire("one", { wait: false, timeoutMs: 500 }, signal());
  await until(() => backend.calls.includes("devices"));
  gate.resolve();
  expect((await acquisition).id).toBe("one");
});

test("ownership and owner session are durable before boot, and runtime identity is durable afterward", async () => {
  const { pool, backend, journal } = fixture([device("avd")]);
  backend.runtimeIds = true;
  backend.onBoot = () => expect(journal()).toEqual([{ key: "avd", session: "thread", device: { id: "avd" } }]);
  expect((await pool.acquire("thread", { deviceId: "avd", boot: true }, signal())).id).toBe("runtime-avd");
  expect(journal()).toEqual([{ key: "avd", session: "thread", device: { id: "runtime-avd" } }]);
  expect((await pool.acquire("thread", { deviceId: "avd" }, signal())).id).toBe("runtime-avd");
  await pool.release("thread");
  expect(backend.calls).toContain("shutdown:runtime-avd");
  expect(journal()).toEqual([]);
});

test("original and runtime device identities remain reserved during a lease", async () => {
  const { pool, backend } = fixture([device("avd")]);
  backend.runtimeIds = true;
  await pool.acquire("thread", { deviceId: "avd", boot: true }, signal());
  await expect(pool.acquire("other", { deviceId: "runtime-avd", wait: false }, signal())).rejects.toThrow("available");
  await expect(pool.acquire("other", { deviceId: "avd", wait: false }, signal())).rejects.toThrow("available");
});

test("failed boots clean up devices that partially started", async () => {
  const { pool, backend, journal } = fixture([device("one")]);
  backend.bootFailure = true;
  await expect(pool.acquire("thread", { boot: true }, signal())).rejects.toThrow("Boot failed");
  await until(() => backend.calls.includes("shutdown:one"));
  expect(journal()).toEqual([]);
  expect(pool.current("thread")).toBeUndefined();
  backend.bootFailure = false;
  expect((await pool.acquire("thread", { boot: true }, signal())).id).toBe("one");
});

test("timeout returns promptly while a late boot remains reserved until cleanup", async () => {
  const { pool, backend, journal } = fixture([device("one")]);
  const gate = deferred();
  backend.bootGate = gate.promise;
  const result = pool.acquire("thread", { boot: true, timeoutMs: 20 }, signal()).catch((error: Error) => error);
  await until(() => backend.calls.includes("boot:one"));
  expect(await result).toMatchObject({ message: "Device acquisition timed out" });
  expect(journal()).toHaveLength(1);
  await expect(pool.acquire("other", { boot: true, wait: false }, signal())).rejects.toThrow("available");
  gate.resolve();
  await pool.release("thread");
  expect(journal()).toEqual([]);
  expect(backend.calls).toContain("shutdown:one");
});

test("fence cancels waiting acquisition and requires open before reuse", async () => {
  const { pool, backend } = fixture([device("one", true)]);
  await pool.acquire("owner", {}, signal());
  const waiting = pool.acquire("waiter", {}, signal()).catch((error: Error) => error);
  await until(() => backend.calls.filter((call) => call === "devices").length > 1);
  pool.fence("waiter");
  expect(await waiting).toBeInstanceOf(Error);
  await expect(pool.acquire("waiter", {}, signal())).rejects.toThrow("closed");
  await pool.release("owner");
  pool.open("waiter");
  expect((await pool.acquire("waiter", {}, signal())).id).toBe("one");
});

test("fence during boot prevents late admission and open waits for shutdown", async () => {
  const { pool, backend } = fixture([device("one")]);
  const gate = deferred();
  backend.bootGate = gate.promise;
  const original = pool.acquire("thread", { boot: true }, signal()).catch((error: Error) => error);
  await until(() => backend.calls.includes("boot:one"));
  pool.fence("thread");
  expect(await original).toBeInstanceOf(Error);
  pool.open("thread");
  const reopened = pool.acquire("thread", { boot: true }, signal());
  gate.resolve();
  expect((await reopened).id).toBe("one");
  expect(backend.calls.filter((call) => call === "boot:one")).toHaveLength(2);
  expect(backend.calls).toContain("shutdown:one");
});

test("release drains native uses before closing the daemon session and stopping a virtual device", async () => {
  const { pool, backend } = fixture([device("one")]);
  await pool.acquire("thread", { boot: true }, signal());
  const gate = deferred();

  const active = pool.use("thread", "one", async () => {
    await gate.promise;

    return 42;
  });

  await Promise.resolve();
  const releasing = pool.release("thread");
  await expect(pool.use("thread", "one", async () => 0)).rejects.toThrow("Acquire");
  expect(backend.calls).not.toContain("close:thread");
  expect(backend.calls).not.toContain("shutdown:one");
  gate.resolve();
  expect(await active).toBe(42);
  await releasing;
  expect(backend.calls.indexOf("close:thread")).toBeLessThan(backend.calls.indexOf("shutdown:one"));
  expect(pool.current("thread")).toBeUndefined();
});

test("use validates session and selector, drains failed work, and does not idle-release active work", async () => {
  const { pool, backend } = fixture([device("one")], 20);
  await expect(pool.use("thread", undefined, async () => 1)).rejects.toThrow("Acquire");
  await pool.acquire("thread", { boot: true }, signal());
  await expect(pool.use("thread", "other", async () => 1)).rejects.toThrow("different device");
  const gate = deferred();

  const work = pool.use("thread", undefined, async () => {
    await gate.promise;
    throw new Error("Native operation failed");
  });

  const result = work.catch((error: Error) => error);
  await Bun.sleep(40);
  expect(backend.calls).not.toContain("shutdown:one");
  gate.resolve();
  expect(await result).toMatchObject({ message: "Native operation failed" });
  await until(() => backend.calls.includes("shutdown:one"));
});

test("failed session close retains the lease and durable ownership, then retries before shutdown", async () => {
  const { pool, backend, journal } = fixture([device("one")], 25);
  await pool.acquire("thread", { boot: true }, signal());
  backend.closeFailure = true;
  await expect(pool.release("thread")).rejects.toThrow("Session cleanup failed");
  expect(journal()).toHaveLength(1);
  expect(backend.calls).not.toContain("shutdown:one");
  await expect(pool.use("thread", undefined, async () => 1)).rejects.toThrow("Acquire");
  await expect(pool.acquire("other", { wait: false, boot: true }, signal())).rejects.toThrow("available");
  backend.closeFailure = false;
  await until(() => backend.calls.includes("shutdown:one"));
  expect(journal()).toEqual([]);
});

test("idle cleanup retries failed daemon close for an external lease without ever stopping it", async () => {
  const { pool, backend } = fixture([device("external", true)], 15);
  backend.closeFailure = true;
  await pool.acquire("thread", {}, signal());
  await until(() => backend.calls.filter((call) => call === "close:thread").length >= 2);
  backend.closeFailure = false;
  await until(() => backend.calls.filter((call) => call === "close:thread").length >= 3);
  expect(backend.calls).not.toContain("shutdown:external");
  expect((await pool.acquire("other", {}, signal())).id).toBe("external");
});

test("shutdown failure retains durable ownership and lease until a successful retry", async () => {
  const { pool, backend, journal } = fixture([device("one")], 20);
  await pool.acquire("thread", { boot: true }, signal());
  backend.shutdownFailure = true;
  await expect(pool.release("thread")).rejects.toThrow("Native shutdown failed");
  expect(journal()).toHaveLength(1);
  backend.shutdownFailure = false;
  await until(() => journal().length === 0);
  expect(backend.calls.filter((call) => call === "shutdown:one").length).toBeGreaterThan(1);
});

test("recovery closes only recorded managed owner sessions and stops only owned virtual devices", async () => {
  const dataDir = makeDir("canopy-device-pool-recovery-");
  writeFileSync(
    join(dataDir, "device-pool.json"),
    JSON.stringify([{ key: "avd", session: "managed", stop: true, device: device("runtime-avd", true) }]),
  );
  const backend = new Backend([device("runtime-avd", true), device("external", true), device("phone", true, "device")]);
  const pool = new DevicePool({ dataDir, backend });
  pools.push(pool);
  await pool.recover();
  expect(backend.calls).toEqual(["close:managed", "shutdown:runtime-avd"]);
  expect(JSON.parse(readFileSync(join(dataDir, "device-pool.json"), "utf8"))).toEqual([]);
});

test("recovery keeps failed ownership durable and can be retried after backend recovery", async () => {
  const dataDir = makeDir("canopy-device-pool-recovery-");
  writeFileSync(
    join(dataDir, "device-pool.json"),
    JSON.stringify([{ key: "avd", session: "managed", stop: true, device: device("avd") }]),
  );
  const backend = new Backend([device("avd", true)]);
  backend.shutdownFailure = true;
  const pool = new DevicePool({ dataDir, backend });
  pools.push(pool);
  await expect(pool.recover()).rejects.toThrow("Native shutdown failed");
  expect(journalSchema.parse(JSON.parse(readFileSync(join(dataDir, "device-pool.json"), "utf8")))).toHaveLength(1);
  backend.shutdownFailure = false;
  await pool.recover();
  expect(JSON.parse(readFileSync(join(dataDir, "device-pool.json"), "utf8"))).toEqual([]);
});

test("close cancels waits and drains pending native work before returning", async () => {
  const { pool, backend } = fixture([device("one")]);
  const gate = deferred();
  backend.bootGate = gate.promise;
  const booting = pool.acquire("one", { boot: true }, signal()).catch((error: Error) => error);
  await until(() => backend.calls.includes("boot:one"));
  const waiting = pool.acquire("two", { boot: true }, signal()).catch((error: Error) => error);
  const closing = pool.close();
  expect(await booting).toBeInstanceOf(Error);
  expect(await waiting).toBeInstanceOf(Error);
  gate.resolve();
  await closing;
  expect(backend.calls).toContain("shutdown:one");
  await expect(pool.acquire("one", {}, signal())).rejects.toThrow("closed");
  expect(() => pool.open("one")).toThrow("closed");
});

test("preflight rejection never shuts down a device booted by an external owner", async () => {
  const { pool, backend, journal } = fixture([device("simulator", false, "simulator")]);
  backend.preflightFailure = true;
  await expect(pool.acquire("thread", { boot: true }, signal())).rejects.toThrow("Externally booted");
  expect(backend.calls).not.toContain("shutdown:simulator");
  expect(journal()).toEqual([]);
  expect(pool.current("thread")).toBeUndefined();
});

test("queued native use cannot start after a synchronous fence and reopen", async () => {
  const { pool } = fixture([device("one", true)]);
  await pool.acquire("thread", {}, signal());
  let started = false;

  const work = pool.use("thread", undefined, async () => {
    started = true;
  });

  pool.fence("thread");
  pool.open("thread");
  await expect(work).rejects.toThrow();
  expect(started).toBe(false);
  await pool.release("thread");
  expect((await pool.acquire("thread", {}, signal())).id).toBe("one");
});

test("external and physical leases persist sessions for restart recovery without permission to stop devices", async () => {
  const { pool, backend, dataDir } = fixture([device("external", true), device("phone", true, "device")]);
  await pool.acquire("external-thread", { deviceId: "external" }, signal());
  await pool.acquire("phone-thread", { deviceId: "phone" }, signal());
  const saved = readFileSync(join(dataDir, "device-pool.json"), "utf8");
  await pool.close();
  backend.calls = [];
  writeFileSync(join(dataDir, "device-pool.json"), saved);
  const recovered = new DevicePool({ dataDir, backend });
  pools.push(recovered);
  await recovered.recover();
  expect(backend.calls.toSorted()).toEqual(["close:external-thread", "close:phone-thread"]);
  expect(JSON.parse(readFileSync(join(dataDir, "device-pool.json"), "utf8"))).toEqual([]);
});

test("failed close can be retried while the pool remains fenced", async () => {
  const { pool, backend, journal } = fixture([device("one")]);
  await pool.acquire("thread", { boot: true }, signal());
  backend.shutdownFailure = true;
  await expect(pool.close()).rejects.toThrow("Native shutdown failed");
  expect(journal()).toHaveLength(1);
  await expect(pool.acquire("thread", {}, signal())).rejects.toThrow("closed");
  backend.shutdownFailure = false;
  await pool.close();
  expect(journal()).toEqual([]);
});

test("journal write failure never admits a lease or starts a native device and remains recoverable", async () => {
  const { pool, backend, dataDir } = fixture([device("one")]);
  const blocked = join(dataDir, "device-pool.json.tmp");
  mkdirSync(blocked);
  await expect(pool.acquire("thread", { boot: true }, signal())).rejects.toThrow();
  expect(backend.calls).not.toContain("boot:one");
  expect(backend.calls).not.toContain("shutdown:one");
  expect(pool.current("thread")).toBeUndefined();
  rmdirSync(blocked);
  await pool.release("thread");
  expect((await pool.acquire("thread", { boot: true }, signal())).id).toBe("one");
});

test("repeated open preserves cancellation of an acquisition already in progress", async () => {
  const { pool, backend } = fixture([device("one", true)]);
  await pool.acquire("owner", {}, signal());
  const waiting = pool.acquire("waiter", {}, signal()).catch((error: Error) => error);
  await until(() => backend.calls.filter((call) => call === "devices").length > 1);
  pool.open("waiter");
  pool.fence("waiter");
  expect(await waiting).toBeInstanceOf(Error);
});

test("reopen cannot admit a second device while a failed release still owns the first", async () => {
  const { pool, backend, journal } = fixture([device("one"), device("two")], 20);
  await pool.acquire("thread", { deviceId: "one", boot: true }, signal());
  backend.shutdownFailure = true;
  await expect(pool.release("thread")).rejects.toThrow("Native shutdown failed");
  pool.open("thread");
  await expect(pool.acquire("thread", { deviceId: "two", boot: true }, signal())).rejects.toThrow("cleanup is pending");
  backend.shutdownFailure = false;
  await until(() => journal().length === 0);
  expect((await pool.acquire("thread", { deviceId: "two", boot: true }, signal())).id).toBe("two");
});

test("preflight rejection persists no-shutdown permission before a failing session cleanup", async () => {
  const { pool, backend, dataDir } = fixture([device("simulator", false, "simulator")]);
  backend.preflightFailure = true;
  backend.closeFailure = true;
  await expect(pool.acquire("thread", { boot: true }, signal())).rejects.toThrow("Externally booted");
  const saved = readFileSync(join(dataDir, "device-pool.json"), "utf8");
  expect(z.array(z.object({ stop: z.boolean() })).parse(JSON.parse(saved))).toEqual([{ stop: false }]);
  expect(backend.calls).not.toContain("shutdown:simulator");
  backend.closeFailure = false;
  await pool.close();
  writeFileSync(join(dataDir, "device-pool.json"), saved);
  backend.calls = [];
  const recovered = new DevicePool({ dataDir, backend });
  pools.push(recovered);
  await recovered.recover();
  expect(backend.calls).toEqual(["close:thread"]);
});
