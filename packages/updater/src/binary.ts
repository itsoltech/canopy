import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { compareVersions, releaseFetch, type InstallKind, type ReleaseAsset, type ReleaseSourceOptions } from "./release.ts";

/** The child requests a restart; the resident old supervisor remains the rollback watchdog. */
export const UPDATE_RESTART_EXIT_CODE = 75;
export interface UpdateRecord {
  commandId: string;
  previousVersion: string;
  version: string;
  state: "restarting" | "succeeded" | "failed";
  reason: string;
}
export function isStandalone(): boolean {
  return /(?:\$bunfs|~BUN)[/\\]/i.test(Bun.main);
}
export function installKind(env: NodeJS.ProcessEnv = process.env): InstallKind {
  if (env["CANOPY_INSTALL_KIND"] === "docker" || existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return "docker";
  return isStandalone() ? "binary" : "source";
}
export function managedInstructions(kind: string): string {
  return kind === "docker" ? "Managed externally. Pull the new image tag and recreate this container." :
    "Managed externally. Update the Canopy checkout, run bun install, then restart the service.";
}

export async function readUpdateRecord(binaryPath = process.execPath): Promise<UpdateRecord | undefined> {
  try { return JSON.parse(await readFile(`${binaryPath}.update.json`, "utf8")) as UpdateRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function recordUpdate(binaryPath: string, record: UpdateRecord): Promise<void> {
  const temp = `${binaryPath}.update.${crypto.randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try { await fd.writeFile(JSON.stringify(record)); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temp, `${binaryPath}.update.json`);
}
export async function clearUpdateResult(binaryPath = process.execPath): Promise<void> {
  const record = await readUpdateRecord(binaryPath);
  if (record && record.state !== "restarting") await rm(`${binaryPath}.update.json`, { force: true });
}

export async function* downloadAsset(asset: ReleaseAsset, options: ReleaseSourceOptions = {}): AsyncIterable<Uint8Array> {
  const response = await releaseFetch(asset.url, options);
  if (!response.body) throw new Error("Release asset has no body");
  yield* response.body;
}

/** Shared by the binary updater and the gateway cache; partial or corrupt files never become executable. */
export async function writeVerified(path: string, asset: ReleaseAsset, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  const fd = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > asset.size) throw new Error("Release asset exceeds manifest size");
      hash.update(chunk);
      // FileHandle.write may write fewer bytes; writeFile consumes this whole chunk.
      await fd.writeFile(chunk);
    }
    if (size !== asset.size) throw new Error("Release asset size does not match manifest");
    if (hash.digest("hex") !== asset.sha256.toLowerCase()) throw new Error("Release asset SHA-256 does not match manifest");
    await fd.sync();
  } catch (error) { await rm(path, { force: true }); throw error; }
  finally { await fd.close(); }
}

export interface StageUpdateOptions {
  binaryPath: string;
  currentVersion: string;
  version: string;
  commandId: string;
  asset: ReleaseAsset;
  chunks?: AsyncIterable<Uint8Array>;
  source?: ReleaseSourceOptions;
  allowDowngrade?: boolean;
}
/** Verified next-file + preserved previous executable + a single atomic replacement on POSIX. */
export async function stageBinaryUpdate(options: StageUpdateOptions): Promise<void> {
  const { binaryPath, asset } = options;
  if (process.platform === "win32") throw new Error("Windows binary replacement requires an external service installer");
  if (compareVersions(options.version, options.currentVersion) < 0 && !options.allowDowngrade) throw new Error("Downgrade requires an explicit user request");
  if (compareVersions(options.version, options.currentVersion) === 0) throw new Error("This version is already installed");
  if (!(await lstat(binaryPath)).isFile()) throw new Error("Executable must be a regular file, not a symlink");
  const existing = await readUpdateRecord(binaryPath);
  if (existing?.state === "restarting") throw new Error("An update is already awaiting a successful restart");
  const lockPath = `${binaryPath}.update.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  const next = `${binaryPath}.${crypto.randomUUID()}.next`;
  const backup = `${binaryPath}.${crypto.randomUUID()}.backup`;
  try {
    await writeVerified(next, asset, options.chunks ?? downloadAsset(asset, options.source));
    await chmod(next, 0o700);
    await copyFile(binaryPath, backup);
    const backupFd = await open(backup, "r");
    try { await backupFd.sync(); } finally { await backupFd.close(); }
    await rename(backup, `${binaryPath}.bak`);
    await recordUpdate(binaryPath, { commandId: options.commandId, previousVersion: options.currentVersion,
      version: options.version, state: "restarting", reason: "" });
    try { await rename(next, binaryPath); }
    catch (error) { await rm(`${binaryPath}.update.json`, { force: true }); throw error; }
    const directory = await open(dirname(binaryPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
    await rm(next, { force: true });
    await rm(backup, { force: true });
  }
}

/** A WorkerLink Welcome (worker) or a ready DB + listener (gateway) confirms the new process. */
export async function confirmStartup(binaryPath = process.execPath, version = CANOPY_VERSION): Promise<void> {
  const record = await readUpdateRecord(binaryPath);
  if (record?.state === "restarting" && record.version === version) await recordUpdate(binaryPath, { ...record, state: "succeeded" });
}
export async function rollbackBinary(binaryPath: string, reason: string): Promise<void> {
  const record = await readUpdateRecord(binaryPath);
  if (!record || record.state !== "restarting") return;
  await rename(`${binaryPath}.bak`, binaryPath);
  await recordUpdate(binaryPath, { ...record, state: "failed", reason });
}

export interface SupervisorOptions {
  binaryPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}
/**
 * The supervisor runs from the previous executable already mapped in memory. It can restore .bak even
 * if the candidate cannot execute at all. Both foreground and service installs use the same watchdog.
 * It forwards user signals and never restarts an ordinary exit; systemd/launchd own crash restart policy.
 */
export async function superviseBinary(options: SupervisorOptions): Promise<number> {
  const env = { ...process.env, ...options.env, CANOPY_SUPERVISED: "1" };
  let stopped = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const signals = ["SIGINT", "SIGTERM"] as const;
  const forward = (signal: NodeJS.Signals) => { stopped = true; child?.kill(signal); };
  const onInt = () => forward("SIGINT"), onTerm = () => forward("SIGTERM");
  process.on(signals[0], onInt); process.on(signals[1], onTerm);
  try {
    for (;;) {
      let pending = await readUpdateRecord(options.binaryPath);
      // The update this child must prove (by confirming startup). Once it has, a later "restarting" record is its own
      // next update (a new commandId), whose exit 75 is a normal restart request, not a failed candidate.
      const candidate = pending?.state === "restarting" ? pending.commandId : undefined;
      const unconfirmed = (record: UpdateRecord | undefined) => candidate !== undefined && record?.state === "restarting" && record.commandId === candidate;
      const deadline = Date.now() + (options.startupTimeoutMs ?? 90_000);
      let rolledBack = false;
      try {
        child = Bun.spawn([options.binaryPath, ...options.args], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      } catch (error) {
        if (!pending || pending.state !== "restarting") throw error;
        await rollbackBinary(options.binaryPath, "New executable could not start");
        options.log?.("update rolled back: new executable could not start");
        continue;
      }
      const running = child;
      const watch = setInterval(() => {
        if (stopped || running.exitCode !== null) return;
        void (async () => {
          pending = await readUpdateRecord(options.binaryPath);
          if (unconfirmed(pending) && Date.now() >= deadline) {
            rolledBack = true;
            running.kill("SIGKILL");
          }
        })().catch(() => { rolledBack = true; running.kill("SIGKILL"); });
      }, options.pollMs ?? 250);
      const exit = await running.exited;
      clearInterval(watch);
      child = undefined;
      if (stopped) return exit;
      pending = await readUpdateRecord(options.binaryPath);
      if (pending?.state === "restarting" && (unconfirmed(pending) || rolledBack || exit !== UPDATE_RESTART_EXIT_CODE)) {
        await rollbackBinary(options.binaryPath, rolledBack ? "New version did not become healthy/connect before the startup deadline" : `New version exited before becoming healthy (exit ${exit})`);
        options.log?.("update rolled back: new version did not become healthy");
        continue;
      }
      if (exit === UPDATE_RESTART_EXIT_CODE) continue;
      return exit;
    }
  } finally { process.off(signals[0], onInt); process.off(signals[1], onTerm); }
}

export interface IdleUpdateOptions {
  idle(): boolean | Promise<boolean>;
  /** Synchronous admission barrier: block new turns before inspecting active work. */
  drain(value: boolean): void;
  waiting(): Promise<void>;
  apply(): Promise<void>;
  force?: boolean;
  maxWaitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}
/** Reaching the max delay fails safely; only an explicit force may interrupt active turns. */
export async function whenIdle(options: IdleUpdateOptions): Promise<void> {
  options.drain(true);
  const deadline = Date.now() + (options.maxWaitMs ?? 30 * 60_000);
  try {
    if (!options.force && !await options.idle()) await options.waiting();
    while (!options.force && !await options.idle()) {
      options.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Update deferred: active work did not finish before the idle deadline. Retry or explicitly force the update.");
      await Bun.sleep(options.pollMs ?? 500);
    }
    options.signal?.throwIfAborted();
    await options.apply();
  } finally { options.drain(false); }
}
