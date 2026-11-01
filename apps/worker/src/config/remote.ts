import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ConfigAppliedSchema,
  DeviceLogin,
  Provider,
  ProviderProfileKind,
  type ConfigIssue,
  type ProviderConfig,
  type WorkerConfig,
} from "@open-agents/contracts";
import {
  ProfileError,
  resolveProfiles,
  toProfileReport,
  type NativeToolPolicy,
  type ProfileStatus,
  type ProviderProfileConfig,
} from "../providers/index.ts";

/**
 * Applies the remote WorkerConfig (docs/worker-config.md). Validation happens here, on the device,
 * because only the device can check paths and installed CLIs. Fatal issues reject the whole config
 * and the worker keeps the previous one; other issues disable only the affected entry.
 */

export interface ProviderRuntime {
  readonly enabled: boolean;
  /** Codex: link the device owner's login into the worker's isolated CODEX_HOME (default yes). */
  readonly linkDeviceLogin: boolean;
  /** Resolved executable, when enabled and found. */
  readonly executable?: string;
  readonly version?: string;
  readonly problem?: string;
}

export interface AppliedConfig {
  readonly version: bigint;
  /** Real paths (symlinks resolved), existing directories only. */
  readonly allowedRoots: readonly string[];
  readonly claude: ProviderRuntime;
  readonly codex: ProviderRuntime;
  readonly profiles: readonly ProfileStatus[];
  readonly nativeTools: NativeToolPolicy;
  readonly limits: {
    readonly maxRunningTurns: number;
    readonly maxBackgroundTasks: number;
    readonly drainTimeoutSeconds: number;
    readonly idleUnloadSeconds: number;
  };
}

export const DEFAULT_LIMITS: AppliedConfig["limits"] = {
  maxRunningTurns: 4,
  maxBackgroundTasks: 8,
  drainTimeoutSeconds: 600,
  idleUnloadSeconds: 900,
};

/** Device probes, injectable for tests. */
export interface DeviceProbe {
  which(command: string): string | null;
  /** First line of `<executable> --version`, or undefined when it cannot be run. */
  version(executable: string): string | undefined;
  realDirectory(path: string): string | undefined;
}

export const systemProbe: DeviceProbe = {
  which: (command) => Bun.which(command),
  version: (executable) => {
    const result = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return result.exitCode === 0 ? result.stdout.toString().trim().split("\n")[0] : undefined;
  },
  realDirectory: (path) => {
    if (!existsSync(path)) return undefined;
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  },
};

export type ApplyResult =
  | { readonly applied: true; readonly config: AppliedConfig; readonly report: MessageInitShape<typeof ConfigAppliedSchema> }
  | { readonly applied: false; readonly report: MessageInitShape<typeof ConfigAppliedSchema> };

export function applyWorkerConfig(config: WorkerConfig, probe: DeviceProbe = systemProbe): ApplyResult {
  const issues: Omit<ConfigIssue, "$typeName">[] = [];
  const issue = (path: string, message: string, fatal = false) => issues.push({ path, message, fatal });

  // Allowed roots: absolute, existing directories; symlinks resolved so later checks compare real paths.
  const allowedRoots: string[] = [];
  for (const [i, root] of config.allowedRoots.entries()) {
    if (!isAbsolute(root)) {
      issue(`allowed_roots[${i}]`, `"${root}" is not an absolute path`);
      continue;
    }
    const real = probe.realDirectory(root);
    if (!real) {
      issue(`allowed_roots[${i}]`, `"${root}" does not exist or is not a directory`);
      continue;
    }
    if (!allowedRoots.includes(real)) allowedRoots.push(real);
  }

  const claude = providerRuntime("claude", config.claude, probe, issue);
  const codex = providerRuntime("codex", config.codex, probe, issue);

  let profiles: ProfileStatus[] = [];
  try {
    profiles = resolveProfiles(config.profiles.map((p, i) => profileConfig(p, i, issue)).filter((p) => p !== undefined));
  } catch (error) {
    issue("profiles", error instanceof ProfileError ? error.message : String(error), true);
  }
  for (const status of profiles) {
    if (status.problem) issue(`profiles[${status.config.id}]`, status.problem);
  }

  const limits = config.limits;
  const report = {
    version: config.version,
    issues,
    profiles: profiles.map(toProfileReport),
    providers: [providerInfo(Provider.CLAUDE, claude), providerInfo(Provider.CODEX, codex)],
  };
  if (issues.some((i) => i.fatal)) return { applied: false, report: create(ConfigAppliedSchema, { ...report, applied: false }) };

  return {
    applied: true,
    report: create(ConfigAppliedSchema, { ...report, applied: true }),
    config: {
      version: config.version,
      allowedRoots,
      claude,
      codex,
      profiles,
      nativeTools: {
        nativeSubagents: config.nativeTools?.subagents ?? false,
        nativeScheduling: config.nativeTools?.scheduling ?? false,
        nativeConnectors: config.nativeTools?.connectors ?? false,
      },
      limits: {
        maxRunningTurns: limits?.maxRunningTurns || DEFAULT_LIMITS.maxRunningTurns,
        maxBackgroundTasks: limits?.maxBackgroundTasks || DEFAULT_LIMITS.maxBackgroundTasks,
        drainTimeoutSeconds: limits?.drainTimeoutSeconds || DEFAULT_LIMITS.drainTimeoutSeconds,
        idleUnloadSeconds: limits?.idleUnloadSeconds || DEFAULT_LIMITS.idleUnloadSeconds,
      },
    },
  };
}

/** True when `realPath` (symlinks already resolved) is one of the allowed roots or inside one. */
export function isAllowedPath(config: Pick<AppliedConfig, "allowedRoots">, realPath: string): boolean {
  return config.allowedRoots.some((root) => {
    const rel = relative(root, realPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function providerRuntime(
  name: "claude" | "codex",
  config: ProviderConfig | undefined,
  probe: DeviceProbe,
  issue: (path: string, message: string) => void,
): ProviderRuntime {
  const linkDeviceLogin = config?.deviceLogin !== DeviceLogin.NONE;
  if (!config?.enabled) return { enabled: false, linkDeviceLogin, problem: "disabled in configuration" };
  const executable = config.executablePath || probe.which(name);
  if (!executable) {
    issue(`${name}.executable_path`, `${name} CLI not found on PATH`);
    return { enabled: false, linkDeviceLogin, problem: `${name} CLI not found` };
  }
  const versionLine = probe.version(executable);
  const version = versionLine?.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
  if (config.requiredVersion && version !== config.requiredVersion) {
    const problem = `${name} ${version ?? "(unknown version)"} found, ${config.requiredVersion} required`;
    issue(`${name}.required_version`, problem);
    return { enabled: false, linkDeviceLogin, executable, ...(version !== undefined && { version }), problem };
  }
  return { enabled: true, linkDeviceLogin, executable, ...(version !== undefined && { version }) };
}

function providerInfo(provider: Provider, runtime: ProviderRuntime) {
  return {
    provider,
    available: runtime.enabled,
    version: runtime.version ?? "",
    detail: runtime.problem ?? "",
  };
}

function profileConfig(
  profile: WorkerConfig["profiles"][number],
  index: number,
  issue: (path: string, message: string, fatal?: boolean) => void,
): ProviderProfileConfig | undefined {
  switch (profile.kind) {
    case ProviderProfileKind.NATIVE:
      return { kind: "native", id: profile.id };
    case ProviderProfileKind.CLIPROXYAPI:
      return {
        kind: "cliproxyapi",
        id: profile.id,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        ...(profile.providers.length > 0 && {
          providers: profile.providers.map((p) => (p === Provider.CLAUDE ? ("claude" as const) : ("codex" as const))),
        }),
      };
    default:
      issue(`profiles[${index}].kind`, `unsupported profile kind for "${profile.id}"`);
      return undefined;
  }
}
