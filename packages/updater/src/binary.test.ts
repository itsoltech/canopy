import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { confirmStartup, readUpdateRecord, stageBinaryUpdate, superviseBinary, whenIdle } from "./binary.ts";
import type { ReleaseAsset } from "./release.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const oldBinary = '#!/bin/sh\nprintf "1.0.0\\n"\n';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "oa-updater-")); directories.push(dir);
  const binaryPath = join(dir, "canopy-worker");
  await writeFile(binaryPath, oldBinary, { mode: 0o700 });
  return binaryPath;
}
function artifact(bytes: string): ReleaseAsset { return { app: "worker", os: "linux", arch: "x64", name: "canopy-worker-linux-x64", url: "https://example.com/worker", sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes) }; }
async function* chunks(bytes: string) { yield Buffer.from(bytes); }

describe.skipIf(process.platform === "win32")("binary update and independent rollback watchdog", () => {
  test("atomically replaces a verified executable, keeps .bak and persists post-start success", async () => {
    const binaryPath = await fixture(), next = '#!/bin/sh\nprintf "2.0.0\\n"\n';
    await stageBinaryUpdate({ binaryPath, currentVersion: "1.0.0", version: "2.0.0", commandId: "update-1", asset: artifact(next), chunks: chunks(next) });
    expect(await readFile(`${binaryPath}.bak`, "utf8")).toBe(oldBinary);
    const process = Bun.spawn([binaryPath], { stdout: "pipe" });
    expect(await new Response(process.stdout).text()).toBe("2.0.0\n");
    expect(await process.exited).toBe(0);
    await confirmStartup(binaryPath, "2.0.0");
    expect(await readUpdateRecord(binaryPath)).toMatchObject({ commandId: "update-1", state: "succeeded" });
  });
  test("rejects SHA/size mismatches and downgrades without changing the current executable", async () => {
    const binaryPath = await fixture(), next = '#!/bin/sh\nexit 0\n';
    const options = { binaryPath, currentVersion: "1.0.0", version: "2.0.0", commandId: "update-2" };
    await expect(stageBinaryUpdate({ ...options, asset: { ...artifact(next), sha256: "0".repeat(64) }, chunks: chunks(next) })).rejects.toThrow("SHA-256");
    await expect(stageBinaryUpdate({ ...options, asset: { ...artifact(next), size: 1 }, chunks: chunks(next) })).rejects.toThrow("size");
    await expect(stageBinaryUpdate({ ...options, version: "0.9.0", asset: artifact(next), chunks: chunks(next) })).rejects.toThrow("Downgrade");
    expect(await readFile(binaryPath, "utf8")).toBe(oldBinary);
    expect(await readUpdateRecord(binaryPath)).toBeUndefined();
  });
  test("restores .bak when the new executable exits before connecting", async () => {
    const binaryPath = await fixture(), next = '#!/bin/sh\nexit 23\n';
    await stageBinaryUpdate({ binaryPath, currentVersion: "1.0.0", version: "2.0.0", commandId: "failure", asset: artifact(next), chunks: chunks(next) });
    expect(await superviseBinary({ binaryPath, args: [], startupTimeoutMs: 200, pollMs: 10 })).toBe(0);
    expect(await readFile(binaryPath, "utf8")).toBe(oldBinary);
    expect(await readUpdateRecord(binaryPath)).toMatchObject({ state: "failed", reason: expect.stringContaining("exit 23") });
  });
  test("restores .bak when the new executable never becomes healthy", async () => {
    const binaryPath = await fixture(), next = '#!/bin/sh\nexec sleep 30\n';
    await stageBinaryUpdate({ binaryPath, currentVersion: "1.0.0", version: "2.0.0", commandId: "timeout", asset: artifact(next), chunks: chunks(next) });
    expect(await superviseBinary({ binaryPath, args: [], startupTimeoutMs: 70, pollMs: 10 })).toBe(0);
    expect(await readUpdateRecord(binaryPath)).toMatchObject({ state: "failed", reason: expect.stringContaining("deadline") });
  });
  test("waits for idle with an admission barrier; timeout does not interrupt work; explicit force bypasses waiting", async () => {
    let active = true, draining = false, applied = 0;
    const waiting = Promise.withResolvers<void>();
    const pending = whenIdle({ idle: () => !active, drain: (v) => draining = v, waiting: async () => waiting.resolve(), apply: async () => { expect(draining).toBe(true); applied++; }, pollMs: 5, maxWaitMs: 1000 });
    await waiting.promise;
    expect(draining).toBe(true); expect(applied).toBe(0);
    active = false; await pending;
    expect(applied).toBe(1); expect(draining).toBe(false);
    await expect(whenIdle({ idle: () => false, drain: (v) => draining = v, waiting: async () => {}, apply: async () => { applied++; }, pollMs: 5, maxWaitMs: 10 })).rejects.toThrow("deferred");
    expect(applied).toBe(1); expect(draining).toBe(false);
    await whenIdle({ idle: () => false, drain: (v) => draining = v, waiting: async () => {}, apply: async () => { applied++; }, force: true });
    expect(applied).toBe(2);
  });
});
