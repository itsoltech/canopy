import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { readEnv } from "@canopy/domain/env";

/**
 * The only configuration a worker keeps locally: how to reach the gateway (docs/worker-config.md).
 * Providers, profiles and limits come from the gateway as WorkerConfig.
 * The worker always dials out, so it works behind NAT and firewalls without open ports.
 *
 * The file holds the worker credential: like an SSH key it must not be readable by other users.
 */
export const LocalConfig = Schema.Struct({
  gateway_url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s/]+/)).annotate({
    description: "Gateway base URL, e.g. https://agents.example.com (http only for local development).",
  }),
  worker_id: Schema.String.check(Schema.isUUID()),
  credential: Schema.String.check(Schema.isMinLength(16)),
  /** Legacy setting accepted and ignored, including invalid/nonexistent directories. */
  allowedRoots: Schema.optionalKey(Schema.Unknown),
  allowed_roots: Schema.optionalKey(Schema.Unknown),
  /** Extra CA (PEM file) for a gateway with a private certificate. */
  ca_file: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** Journal, blobs in flight, logs. Defaults to a per-OS data directory. */
  data_dir: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** HTTP/2 PING interval; keeps NAT mappings alive and detects dead links. */
  ping_interval_seconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3600 }))),
});

export type LocalConfig = Schema.Schema.Type<typeof LocalConfig>;

export type Platform = "linux" | "darwin" | "win32" | (string & {});

/** Directory name of the worker's files; before the rename it was "open-agents", still read when only it exists. */
const APP_DIR = "canopy";
const LEGACY_APP_DIR = "open-agents";

/** `<base>/canopy/...`, or the pre-rename `<base>/open-agents/...` when only that exists (nothing is moved). */
function appPath(base: string, rest: readonly string[], exists: (path: string) => boolean): string {
  const current = join(base, APP_DIR, ...rest);
  const legacy = join(base, LEGACY_APP_DIR, ...rest);
  return !exists(current) && exists(legacy) ? legacy : current;
}

/** Default config file location per OS; CANOPY_WORKER_CONFIG overrides it. */
export function defaultConfigPath(env: Readonly<Record<string, string | undefined>>, platform: Platform, home = homedir(), exists: (path: string) => boolean = existsSync): string {
  const configured = readEnv("CANOPY_WORKER_CONFIG", env);
  if (configured) return configured;
  switch (platform) {
    case "win32":
      return appPath(env["APPDATA"] ?? join(home, "AppData", "Roaming"), ["worker.json"], exists);
    case "darwin":
      return appPath(join(home, "Library", "Application Support"), ["worker.json"], exists);
    default:
      return appPath(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), ["worker.json"], exists);
  }
}

export function defaultDataDir(env: Readonly<Record<string, string | undefined>>, platform: Platform, home = homedir(), exists: (path: string) => boolean = existsSync): string {
  switch (platform) {
    case "win32":
      return appPath(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), [], exists);
    case "darwin":
      return appPath(join(home, "Library", "Application Support"), [], exists);
    default:
      return appPath(env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), [], exists);
  }
}

/** Decodes the file content strictly (unknown keys are errors: typos must not be ignored). */
export function parseLocalConfig(text: string): Result.Result<LocalConfig, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return Result.fail("worker config is not valid JSON");
  }
  const decoded = Schema.decodeUnknownResult(LocalConfig)(raw, { onExcessProperty: "error" });
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail(`worker config: ${decoded.failure.message}`);
}

/** POSIX only: the credential file must not be readable or writable by group or others. */
export function checkFilePermissions(path: string, platform: Platform): string | undefined {
  if (platform === "win32") return undefined; // ACLs are set by the installer
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o077) === 0 ? undefined : `${path} is accessible by other users (mode ${mode.toString(8)}); run chmod 600`;
}

export async function loadLocalConfig(path: string, platform: Platform): Promise<Result.Result<LocalConfig, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return Result.fail(`worker config not found at ${path} (enroll the worker first)`);
  const permissions = checkFilePermissions(path, platform);
  if (permissions) return Result.fail(permissions);
  return parseLocalConfig(await file.text());
}
