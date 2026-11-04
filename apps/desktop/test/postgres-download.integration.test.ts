import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, tempDirs } from "@canopy/testing";
import { PostgresInstaller } from "../src/runtime/postgres-install.ts";
import { postgresArchive, postgresRegistry } from "./postgres-fixture.ts";

const makeTemp = tempDirs();
const fixture = postgresArchive(tempDir("canopy-postgres-download-fixture-"));
const registries: Awaited<ReturnType<typeof postgresRegistry>>[] = [];

afterAll(async () => {
  for (const registry of registries) await registry.close();
});

async function registry(interrupt = false) {
  const value = await postgresRegistry(fixture.bytes, interrupt);
  registries.push(value);

  return value;
}

const signal = () => new AbortController().signal;

test("verified Postgres is executable, installed atomically, reused offline and old unused runtimes are removed", async () => {
  const server = await registry();
  const data = makeTemp("canopy-postgres-cache-");
  const progress: string[] = [];
  const installer = new PostgresInstaller(fixture.manifest, data, (value) => progress.push(value.phase), server);
  expect(existsSync(installer.directory)).toBe(false);
  const directory = await installer.ensure(signal());
  expect(directory).toBe(installer.directory);
  expect(progress).toContain("downloading");
  expect(progress).toContain("verifying");
  expect(progress).toContain("installing");
  expect(progress.at(-1)).toBe("ready");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const version = Bun.spawnSync([join(directory, "bin", "postgres" + suffix), "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString()).toContain(`PostgreSQL) ${fixture.pin.major}.`);
  const old = join(data, "versions", `18.5.0-beta.1-${fixture.pin.target}-old`);
  mkdirSync(old);
  writeFileSync(join(old, "kept-until-new-runtime-starts"), "old");
  server.offline(true);
  const cached = new PostgresInstaller(fixture.manifest, data, () => {}, server);
  expect(await cached.ensure(signal())).toBe(directory);
  expect(server.ranges).toHaveLength(1);
  cached.cleanup();
  expect(existsSync(old)).toBe(false);
  expect(readdirSync(join(data, "versions"))).toEqual([directory.split(/[\\/]/).at(-1)!]);
}, 120_000);

test("bad SHA-512 is rejected before extraction and leaves no install or partial download", async () => {
  const server = await registry();
  const data = makeTemp("canopy-postgres-bad-hash-");
  const manifest = join(data, "bad-pin.json");
  writeFileSync(
    manifest,
    JSON.stringify({ ...fixture.pin, integrity: `sha512-${createHash("sha512").update("wrong").digest("base64")}` }),
  );
  const installer = new PostgresInstaller(manifest, data, () => {}, server);
  await expect(installer.ensure(signal())).rejects.toThrow("SHA-512 integrity verification failed");
  expect(existsSync(installer.directory)).toBe(false);
  expect(readdirSync(join(data, "versions"))).toEqual([]);
  expect(existsSync(join(data, "data"))).toBe(false);
}, 30_000);

test("interrupted transfer resumes with HTTP Range and only exposes a complete executable", async () => {
  const server = await registry(true);
  const data = makeTemp("canopy-postgres-interrupted-");

  const installer = new PostgresInstaller(
    fixture.manifest,
    data,
    (value) => {
      if (value.phase !== "ready") expect(existsSync(installer.directory)).toBe(false);
    },
    server,
  );

  const directory = await installer.ensure(signal());
  expect(server.ranges.length).toBeGreaterThanOrEqual(2);
  expect(server.ranges[0]).toBeUndefined();
  expect(server.ranges.some((range) => /^bytes=[1-9]\d*-$/.test(range ?? ""))).toBe(true);
  expect(existsSync(join(directory, "installed.json"))).toBe(true);
  expect(readdirSync(join(data, "versions"))).toHaveLength(1);
}, 120_000);

test("an app with a new Postgres major refuses the existing data before any download or cleanup", async () => {
  const server = await registry();
  const data = makeTemp("canopy-postgres-major-");
  mkdirSync(join(data, "data"));
  writeFileSync(join(data, "data/PG_VERSION"), String(fixture.pin.major - 1));
  mkdirSync(join(data, "versions/previous-runtime"), { recursive: true });
  const installer = new PostgresInstaller(fixture.manifest, data, () => {}, server);
  await expect(installer.ensure(signal())).rejects.toThrow("back up and migrate");
  expect(server.ranges).toHaveLength(0);
  expect(readFileSync(join(data, "data/PG_VERSION"), "utf8")).toBe(String(fixture.pin.major - 1));
  expect(existsSync(join(data, "versions/previous-runtime"))).toBe(true);
});

test("cancellation preserves resumable bytes but never publishes an unfinished installation", async () => {
  const server = await registry(true);
  const data = makeTemp("canopy-postgres-cancelled-");
  const abort = new AbortController();

  const installer = new PostgresInstaller(
    fixture.manifest,
    data,
    (value) => {
      if (value.phase === "downloading" && value.progress !== undefined && value.progress > 0) abort.abort();
    },
    server,
  );

  await expect(installer.ensure(abort.signal)).rejects.toThrow("cancelled");
  expect(existsSync(installer.directory)).toBe(false);
  const resumed = new PostgresInstaller(fixture.manifest, data, () => {}, server);
  await resumed.ensure(signal());
  expect(server.ranges.some((range) => /^bytes=[1-9]\d*-$/.test(range ?? ""))).toBe(true);
  expect(existsSync(join(resumed.directory, "installed.json"))).toBe(true);
}, 120_000);
