import { createHash } from "node:crypto";
import { governBunSpawn } from "@canopy/process-governor";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isJsonObject, type JsonValue } from "@canopy/domain/json";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import {
  compareVersions,
  releaseFetch,
  type InstallKind,
  type ReleaseAsset,
  type ReleaseSourceOptions,
} from "./release.ts";

/** The child requests a restart; the resident old supervisor remains the rollback watchdog. */
export const UPDATE_RESTART_EXIT_CODE = 75;

/** A confirmed child has drained and stopped so its supervisor can replace itself. */
export const SUPERVISOR_HANDOVER_EXIT_CODE = 76;
const STARTUP_CONFIRMED = "canopy:startup-confirmed";
const SUPERVISOR_HANDOVER = "canopy:supervisor-handover";

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

export function installKind(env: NodeJS.ProcessEnv = process.env, executable = process.execPath): InstallKind {
  // The desktop app ships its gateway/worker inside a signed bundle and updates them itself (never in place).
  // The path also counts: desktop builds before CANOPY_INSTALL_KIND replaced the worker inside the bundle.
  if (env["CANOPY_INSTALL_KIND"] === "desktop" || /[\\/]resources[\\/]runtime[\\/][^\\/]+$/i.test(executable))
    return "desktop";

  if (env["CANOPY_INSTALL_KIND"] === "docker" || existsSync("/.dockerenv") || existsSync("/run/.containerenv"))
    return "docker";

  return isStandalone() ? "binary" : "source";
}

export function managedInstructions(kind: string): string {
  if (kind === "desktop") return "Managed by the Canopy desktop app: it updates itself (Settings → App updates).";

  return kind === "docker"
    ? "Managed externally. Pull the new image tag and recreate this container."
    : "Managed externally. Update the Canopy checkout, run bun install, then restart the service.";
}

export async function readUpdateRecord(binaryPath = process.execPath): Promise<UpdateRecord | undefined> {
  try {
    // SAFETY: only recordUpdate writes this file (0600, atomic rename), always from an UpdateRecord.
    return JSON.parse(await readFile(`${binaryPath}.update.json`, "utf8")) as UpdateRecord;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function recordUpdate(binaryPath: string, record: UpdateRecord): Promise<void> {
  const temp = `${binaryPath}.update.${crypto.randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);

  try {
    await fd.writeFile(JSON.stringify(record));
    await fd.sync();
  } finally {
    await fd.close();
  }

  await rename(temp, `${binaryPath}.update.json`);
}

export async function clearUpdateResult(binaryPath = process.execPath): Promise<void> {
  const record = await readUpdateRecord(binaryPath);

  if (record && record.state !== "restarting") await rm(`${binaryPath}.update.json`, { force: true });
}

export async function* downloadAsset(
  asset: ReleaseAsset,
  options: ReleaseSourceOptions = {},
): AsyncIterable<Uint8Array> {
  const response = await releaseFetch(asset.url, options);

  if (!response.body) throw new Error("Release asset has no body");
  yield* response.body;
}

/** Shared by the binary updater and the gateway cache; partial or corrupt files never become executable. */
export async function writeVerified(
  path: string,
  asset: ReleaseAsset,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
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

    if (hash.digest("hex") !== asset.sha256.toLowerCase())
      throw new Error("Release asset SHA-256 does not match manifest");
    await fd.sync();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await fd.close();
  }
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

  if (process.platform === "win32")
    throw new Error("Windows binary replacement requires an external service installer");

  if (compareVersions(options.version, options.currentVersion) < 0 && !options.allowDowngrade)
    throw new Error("Downgrade requires an explicit user request");

  if (compareVersions(options.version, options.currentVersion) === 0)
    throw new Error("This version is already installed");

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

    try {
      await backupFd.sync();
    } finally {
      await backupFd.close();
    }

    await rename(backup, `${binaryPath}.bak`);
    await recordUpdate(binaryPath, {
      commandId: options.commandId,
      previousVersion: options.currentVersion,
      version: options.version,
      state: "restarting",
      reason: "",
    });

    try {
      await rename(next, binaryPath);
    } catch (error) {
      await rm(`${binaryPath}.update.json`, { force: true });
      throw error;
    }

    const directory = await open(dirname(binaryPath), "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
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

  if (record?.state === "restarting" && record.version === version)
    await recordUpdate(binaryPath, { ...record, state: "succeeded" });

  // Unlike the result file, IPC cannot be consumed by the worker's progress reporter before the watchdog sees it.
  // Send on every healthy startup, including an already confirmed binary started by an older supervisor.
  if (process.connected) process.send?.({ type: STARTUP_CONFIRMED, version });
}

/** Only standalone entrypoints install this listener; the callback shares their ordinary update/drain lock. */
export function onSupervisorHandover(handover: () => Promise<void>, log: (message: string) => void): void {
  process.on("message", (message) => {
    if (!isHandoverRequest(message)) return;
    void handover().catch((cause: unknown) =>
      log(`supervisor handover deferred: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
  });
}

/** IPC from the supervisor (Bun `serialization: "json"`). */
function isHandoverRequest(message: unknown): message is { readonly type: typeof SUPERVISOR_HANDOVER } {
  return typeof message === "object" && message !== null && "type" in message && message.type === SUPERVISOR_HANDOVER;
}

/** IPC from the supervised child, sent by confirmStartup. */
function isStartupConfirmation(
  message: JsonValue,
): message is { readonly type: typeof STARTUP_CONFIRMED; readonly version: string } {
  return isJsonObject(message) && message["type"] === STARTUP_CONFIRMED && typeof message["version"] === "string";
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

interface SupervisorState {
  /** A user signal was forwarded: the next child exit ends supervision. */
  stopped: boolean;
  /** execve is missing or failed once: keep supervising the confirmed child instead. */
  handoverUnavailable: boolean;
}

interface HandoverFacts {
  readonly pending: UpdateRecord | undefined;
  readonly confirmedVersion: string | undefined;
  readonly executable: Awaited<ReturnType<typeof lstat>>;
}

/**
 * After a confirmed child exits for handover, execve into the installed executable (which does not return).
 * Returns true when a signal stopped supervision meanwhile; false to keep supervising.
 */
async function handOver(
  options: SupervisorOptions,
  state: SupervisorState,
  supervisorEnv: NodeJS.ProcessEnv,
  { pending, confirmedVersion, executable }: HandoverFacts,
): Promise<boolean> {
  // A concurrent next update must still run as an unconfirmed candidate under this watchdog.
  // Also refuse to exec a path replaced since this child was launched (including manual replacement).
  const installed = await lstat(options.binaryPath);

  if (state.stopped) return true;

  if (
    (!pending ||
      (pending.state === "succeeded" && pending.version === confirmedVersion) ||
      (pending.state === "failed" && pending.previousVersion === confirmedVersion)) &&
    installed.dev === executable.dev &&
    installed.ino === executable.ino
  ) {
    try {
      options.log?.(`supervisor handover: ${CANOPY_VERSION} -> ${confirmedVersion} (pid ${process.pid})`);
      process.execve!(options.binaryPath, [options.binaryPath, ...options.args], supervisorEnv);
    } catch (error) {
      state.handoverUnavailable = true;
      options.log?.(
        `supervisor handover unavailable: ${error instanceof Error ? error.message : String(error)}; continuing supervision`,
      );
    }
  }

  return false;
}

/** Forwards user signals to the running child and marks supervision stopped. Returns the function that detaches them. */
function forwardSignals(state: SupervisorState, child: () => ReturnType<typeof Bun.spawn> | undefined): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;

  const forward = (signal: NodeJS.Signals) => {
    state.stopped = true;
    child()?.kill(signal);
  };

  const onInt = () => forward("SIGINT"),
    onTerm = () => forward("SIGTERM");

  process.on(signals[0], onInt);
  process.on(signals[1], onTerm);

  return () => {
    process.off(signals[0], onInt);
    process.off(signals[1], onTerm);
  };
}

/** Restores the previous executable after the candidate missed its startup deadline (timedOut) or exited unconfirmed. */
async function rollBackUnhealthy(options: SupervisorOptions, timedOut: boolean, exit: number): Promise<void> {
  await rollbackBinary(
    options.binaryPath,
    timedOut
      ? "New version did not become healthy/connect before the startup deadline"
      : `New version exited before becoming healthy (exit ${exit})`,
  );
  options.log?.("update rolled back: new version did not become healthy");
}

/**
 * The supervisor runs from the previous executable already mapped in memory. It can restore .bak even
 * if the candidate cannot execute at all. Both foreground and service installs use the same watchdog.
 * Only after confirmation and an idle child exit does execve replace it, retaining the manager's PID.
 * It forwards user signals and never restarts an ordinary exit; systemd/launchd own crash restart policy.
 */
export async function superviseBinary(options: SupervisorOptions): Promise<number> {
  const supervisorEnv = { ...process.env, ...options.env };
  delete supervisorEnv["CANOPY_SUPERVISED"];
  const env = { ...supervisorEnv, CANOPY_SUPERVISED: "1" };

  const state: SupervisorState = {
    stopped: false,
    handoverUnavailable: process.platform === "win32" || !process.execve,
  };

  let handoverUnavailableLogged = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stopForwarding = forwardSignals(state, () => child);

  try {
    for (;;) {
      let pending = await readUpdateRecord(options.binaryPath);
      // The update this child must prove (by confirming startup). Once it has, a later "restarting" record is its own
      // next update (a new commandId), whose exit 75 is a normal restart request, not a failed candidate.
      const candidate = pending?.state === "restarting" ? pending.commandId : undefined;
      const expectedVersion = pending?.state === "failed" ? pending.previousVersion : pending?.version;

      const unconfirmed = (record: UpdateRecord | undefined) =>
        candidate !== undefined && record?.state === "restarting" && record.commandId === candidate;

      const deadline = Date.now() + (options.startupTimeoutMs ?? 90_000);
      let rolledBack = false;
      let confirmedVersion: string | undefined;
      let handoverRequested = false;
      let executable: Awaited<ReturnType<typeof lstat>>;

      const requestHandover = () => {
        if (
          state.stopped ||
          !child ||
          child.exitCode !== null ||
          !confirmedVersion ||
          confirmedVersion === CANOPY_VERSION
        )
          return;

        if (state.handoverUnavailable) {
          if (!handoverUnavailableLogged)
            options.log?.("supervisor handover unavailable: restart the service to load the installed supervisor");
          handoverUnavailableLogged = true;

          return;
        }

        try {
          child.send({ type: SUPERVISOR_HANDOVER });
          handoverRequested = true;
        } catch {
          // The child can disconnect IPC while stopping. Its exit, not IPC delivery, decides restart/rollback.
        }
      };

      try {
        executable = await lstat(options.binaryPath);
        child = governBunSpawn("supervisor", () =>
          Bun.spawn([options.binaryPath, ...options.args], {
            env,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            serialization: "json",
            ipc(message: JsonValue, sender) {
              if (
                sender !== child ||
                !isStartupConfirmation(message) ||
                (expectedVersion && message.version !== expectedVersion)
              )
                return;
              confirmedVersion = message.version;
              requestHandover();
            },
          }),
        );
      } catch (error) {
        if (!pending || pending.state !== "restarting") throw error;
        await rollbackBinary(options.binaryPath, "New executable could not start");
        options.log?.("update rolled back: new executable could not start");
        continue;
      }

      const running = child;
      let checking: Promise<void> | undefined;

      const watch = setInterval(() => {
        if (state.stopped || running.exitCode !== null || checking) return;
        checking = (async () => {
          pending = await readUpdateRecord(options.binaryPath);

          if (!confirmedVersion && unconfirmed(pending) && Date.now() >= deadline) {
            rolledBack = true;
            running.kill("SIGKILL");
          }

          requestHandover();
        })()
          .catch(() => {
            rolledBack = true;
            running.kill("SIGKILL");
          })
          .finally(() => {
            checking = undefined;
          });
      }, options.pollMs ?? 250);

      const exit = await running.exited;
      clearInterval(watch);
      await checking;
      child = undefined;

      if (state.stopped) return exit;
      pending = await readUpdateRecord(options.binaryPath);

      const handoverExit =
        exit === SUPERVISOR_HANDOVER_EXIT_CODE && handoverRequested && confirmedVersion !== undefined;

      if (
        pending?.state === "restarting" &&
        (unconfirmed(pending) || rolledBack || (exit !== UPDATE_RESTART_EXIT_CODE && !handoverExit))
      ) {
        await rollBackUnhealthy(options, rolledBack, exit);
        continue;
      }

      if (exit === UPDATE_RESTART_EXIT_CODE) continue;

      if (handoverExit) {
        if (await handOver(options, state, supervisorEnv, { pending, confirmedVersion, executable })) return exit;

        continue;
      }

      return exit;
    }
  } finally {
    stopForwarding();
  }
}
