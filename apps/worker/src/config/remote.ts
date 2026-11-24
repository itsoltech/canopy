import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, HARNESS_NAMES, providerOf, type Harness } from "@canopy/domain/harnesses";
import { decodeJsonObject, isString } from "../providers/json.ts";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ConfigAppliedSchema,
  DeviceLogin,
  Provider,
  type ConfigIssue,
  type ProviderConfig,
  type WorkerConfig,
} from "@canopy/contracts";
import {
  ProfileError,
  resolveProfiles,
  toProfileReport,
  profilesByHarness,
  providersOf,
  type ProfileStatus,
} from "../providers/profiles.ts";
import type { NativeToolPolicy } from "../providers/native-tools.ts";
import { CLIS, cliCommand, discoverCli, findCli, systemCliProbe, type CliProbe } from "../cli-tools/discovery.ts";
import { shellEnvReady } from "../cli-tools/shell-env.ts";
import { grokAuthPath } from "../providers/grok/home.ts";
import { instanceShadowHome } from "./homes.ts";
import { profileConfig } from "./profile-config.ts";
import { inspectProfilePaths } from "./profile-paths.ts";
import { directCodexHome } from "../providers/codex/home.ts";
import { antigravityAuth } from "../providers/antigravity/auth.ts";
import { supportsAntigravityVersion } from "../providers/antigravity/launch.ts";

export { instanceHome, instanceShadowHome } from "./homes.ts";

/**
 * Async preparation keeps configuration validation synchronous and test probes deterministic. The provider CLIs are
 * found exactly as the CLI report finds them (same copy, same version probe, shared through the governor's cache).
 */
export async function prepareSystemProbe(
  config: WorkerConfig,
  cliProbe: CliProbe = systemCliProbe(false),
): Promise<DeviceProbe> {
  await shellEnvReady();
  const chosen = new Map<string, string>();
  const versions = new Map<string, string | undefined>();

  await Promise.all(
    CLIS.map(async (spec) => {
      const found = await discoverCli(spec, config[spec.name]?.executablePath || undefined, cliProbe);

      if (!found.path) return;
      chosen.set(cliCommand(spec.name), found.path);
      versions.set(found.path, found.version || undefined);
    }),
  );

  const own = config.profiles.map((p) => p.executablePath).filter((p) => p && !versions.has(p));
  await Promise.all(
    [...new Set(own)].map(async (executable) => {
      const result = await cliProbe.version(executable);
      versions.set(executable, "line" in result ? result.line : undefined);
    }),
  );

  return {
    ...systemProbe,
    which: (command) => chosen.get(command) ?? null,
    version: (executable) => versions.get(executable),
  };
}

/**
 * Applies the remote WorkerConfig (docs/worker-config.md). Validation happens here, on the device,
 * because only the device can check paths and installed CLIs. Fatal issues reject the whole config
 * and the worker keeps the previous one; other issues disable only the affected entry.
 */

export interface ProviderRuntime {
  readonly enabled: boolean;
  /** Use the device owner's CLI login when the instance has no login of its own (default yes). */
  readonly linkDeviceLogin: boolean;
  /** Resolved executable, when enabled and found. */
  readonly executable?: string;
  readonly version?: string;
  readonly problem?: string;
}

export interface AppliedConfig extends Readonly<Record<Harness, ProviderRuntime>> {
  readonly version: bigint;
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
  /**
   * The CLI login kept in a home (Codex auth.json, Claude .credentials.json): how it authenticates, null when there is
   * none, undefined when the device cannot tell (e.g. Claude on macOS keeps it in the Keychain). Absent = cannot tell.
   */
  login?(harness: "claude" | "codex" | "grok", home: string, authPath?: string): string | null | undefined;
}

/** Where provider instances live on the device (global provider instances, docs/worker-config.md, section 9). */
export interface DeviceHomes {
  /** The worker's data dir: default shadow homes of instances with their own login. */
  readonly dataDir: string;
  /** The device owner's CLI homes (the login linked by default). */
  readonly claude: string;
  readonly codex: string;
  readonly grok?: string;
  readonly grokAuthPath?: string;
  readonly antigravity?: string;
  /** The worker process's environment (keys a native Claude may take from it). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const systemProbe: DeviceProbe = {
  // PATH, then where the official installers put CLIs (a service's PATH often lacks ~/.local/bin).
  which: (command) => findCli(command),
  version: () => undefined,
  realDirectory: (path) => {
    if (!existsSync(path)) return undefined;
    const real = realpathSync(path);

    return statSync(real).isDirectory() ? real : undefined;
  },
  login: (harness, home, authPath) => {
    if (harness === "claude") {
      if (existsSync(join(home, ".credentials.json"))) return "Claude account";

      return process.platform === "darwin" ? undefined : null;
    }

    const file = authPath ?? join(home, "auth.json");

    if (!existsSync(file)) return null;

    if (harness === "grok") return "Grok account";

    try {
      // Only the shape is read: which kind of credential is there, never its value.
      const auth = decodeJsonObject(JSON.parse(readFileSync(file, "utf8")));

      if (auth["tokens"]) return "ChatGPT";

      if (isString(auth["OPENAI_API_KEY"]) && auth["OPENAI_API_KEY"]) return "OpenAI API key";

      return null;
    } catch {
      return undefined;
    }
  },
};

/** Variables that let a native Claude authenticate without a login file. */
const CLAUDE_KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

export type ApplyResult =
  | {
      readonly applied: true;
      readonly config: AppliedConfig;
      readonly report: MessageInitShape<typeof ConfigAppliedSchema>;
    }
  | { readonly applied: false; readonly report: MessageInitShape<typeof ConfigAppliedSchema> };

export function applyWorkerConfig(
  config: WorkerConfig,
  probe: DeviceProbe = systemProbe,
  homes?: DeviceHomes,
): ApplyResult {
  const issues: Omit<ConfigIssue, "$typeName">[] = [];
  const issue = (path: string, message: string, fatal = false) => issues.push({ path, message, fatal });

  const claude = providerRuntime("claude", config.claude, probe, issue);
  const codex = providerRuntime("codex", config.codex, probe, issue);
  const grok = providerRuntime("grok", config.grok, probe, issue);
  const antigravity = providerRuntime("antigravity", config.antigravity, probe, issue);
  // Gateways predating agy never sent its config and cannot interpret its provider enum in availability reports.
  const harnesses = HARNESSES.filter((name) => name !== "antigravity" || config.antigravity);

  let profiles: ProfileStatus[] = [];

  try {
    profiles = resolveProfiles(
      config.profiles.map((p, i) => profileConfig(p, i, issue)).filter((p) => p !== undefined),
      harnesses,
    );
  } catch (error) {
    issue("profiles", error instanceof ProfileError ? error.message : String(error), true);
  }

  for (const status of profiles) {
    // Turned off on purpose: reported with the profile, not as a configuration issue.
    if (status.problem && !status.config.disabled) issue(`profiles[${status.config.id}]`, status.problem);
  }

  // What the device says (CLI, version, login) is reported with each instance, not as a configuration issue.
  // An instance is one harness (provider, id): a profile serving both (a local or older configuration) is checked,
  // and may be unavailable, per harness, so Claude turned off does not take its Codex side down with it.
  const runtimes = { claude, codex, grok, antigravity };
  profiles = profiles
    .flatMap(profilesByHarness)
    .map((status) => inspectProfile(status, runtimes, probe, homes, config));

  // A configured instance executable also works on a machine with no default CLI
  // on PATH. Instances without their own executable keep the missing-CLI status.
  for (const name of harnesses) {
    if (
      !runtimes[name].enabled &&
      profiles.some((status) => status.resolved && providersOf(status.config).includes(name))
    ) {
      runtimes[name] = { enabled: true, linkDeviceLogin: runtimes[name].linkDeviceLogin };
    }
  }

  const limits = config.limits;

  const report = {
    version: config.version,
    issues,
    profiles: profiles.map(toProfileReport),
    providers: harnesses.map((name) => providerInfo(providerOf(name), runtimes[name])),
  };

  if (issues.some((i) => i.fatal))
    return { applied: false, report: create(ConfigAppliedSchema, { ...report, applied: false }) };

  return {
    applied: true,
    report: create(ConfigAppliedSchema, { ...report, applied: true }),
    config: {
      version: config.version,
      ...runtimes,
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

function missingCliProblem(name: Harness) {
  return name === "claude" ? "Claude Code is not installed on this computer" : `${cliCommand(name)} CLI not found`;
}

function providerRuntime(
  name: Harness,
  config: ProviderConfig | undefined,
  probe: DeviceProbe,
  issue: (path: string, message: string) => void,
): ProviderRuntime {
  const linkDeviceLogin = config?.deviceLogin !== DeviceLogin.NONE;

  if (!config?.enabled) return { enabled: false, linkDeviceLogin, problem: "disabled in configuration" };
  const command = cliCommand(name);
  const executable = config.executablePath || probe.which(command);

  if (!executable) {
    const problem = missingCliProblem(name);
    issue(`${name}.executable_path`, name === "claude" ? problem : `${command} CLI not found on PATH`);

    return { enabled: false, linkDeviceLogin, problem };
  }

  const versionLine = probe.version(executable);
  const version = versionLine?.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];

  if (name === "antigravity" && !versionLine)
    return { enabled: false, linkDeviceLogin, problem: `${executable} not found or not runnable` };

  if (name === "antigravity" && !supportsAntigravityVersion(version))
    return {
      enabled: false,
      linkDeviceLogin,
      executable,
      ...(version && { version }),
      problem: "Antigravity threads require agy 1.5.16 or a later 1.x version.",
    };

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

/**
 * What the device says about an instance: its CLI version (its own executable, else the provider's) and how it
 * authenticates. A provider that is off or missing, an executable that does not run and a native instance without
 * any login make it unavailable (pickers leave it out); an endpoint authenticates with its key.
 */
function inspectProfile(
  status: ProfileStatus,
  runtimes: Record<Harness, ProviderRuntime>,
  probe: DeviceProbe,
  homes: DeviceHomes | undefined,
  providers: WorkerConfig,
): ProfileStatus {
  const { config } = status;

  if (config.disabled) return status;
  const harness = providersOf(config)[0]!;
  let runtime = runtimes[harness];
  const own = config.runtime?.executablePath;

  if (harness === "antigravity" && !status.resolved) return status;
  const configured = providers[harness];

  if (own && configured?.enabled && (harness === "antigravity" || runtime.problem === missingCliProblem(harness)))
    runtime = providerRuntime(harness, { ...configured, executablePath: own }, probe, () => {});

  if (!runtime.enabled)
    return {
      config,
      ...(runtime.version && { version: runtime.version }),
      problem: runtime.problem ?? `${harness} is disabled`,
    };
  let version = runtime.version;

  if (own) {
    const line = probe.version(own);

    if (line === undefined) return { config, problem: `${own} not found or not runnable` };
    version = line.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? version;
  }

  const versioned = inspectProfilePaths(
    { ...status, ...(version !== undefined && { version }) },
    harness,
    homes,
    runtime.linkDeviceLogin,
  );

  if (!versioned.resolved) return versioned;

  if (harness === "antigravity") {
    // The device keyring can't be inspected here. Presence of a key selects the Gemini API route without checking it.
    const auth = antigravityAuth(versioned.resolved.env, homes?.env ?? process.env, runtime.linkDeviceLogin);

    if (auth.kind === "unavailable") {
      const { resolved: _, ...rest } = versioned;

      return { ...rest, problem: auth.problem };
    }

    return auth.kind === "key" ? { ...versioned, auth: "Gemini API key configured", loginHomePath: "" } : versioned;
  }

  if (config.kind === "cliproxyapi")
    return status.resolved
      ? { ...versioned, auth: "endpoint key", authenticated: true }
      : { ...versioned, authenticated: false };

  if (!status.resolved || !homes || !probe.login) return versioned;

  // The CLI can store this login in the OS keyring. Only its login status command can identify the account.
  if (harness === "codex" && directCodexHome(config, runtime.linkDeviceLogin, homes.codex)) return versioned;

  // Native: the instance's own login (shadow home), the device owner's (linked), or keys in the environment.
  const vars = { ...homes.env, ...status.resolved.env };

  if (harness === "claude" && CLAUDE_KEY_ENV.some((name) => vars[name]))
    return { ...versioned, auth: "Claude API key (environment)", authenticated: true };

  if (harness === "grok" && (vars["XAI_API_KEY"] || vars["GROK_CODE_XAI_API_KEY"]))
    return { ...versioned, auth: "xAI API key (environment)", authenticated: true };
  const ownLogin = config.runtime?.ownLogin === true;

  const home = ownLogin
    ? instanceShadowHome(homes.dataDir, harness, config.id, config.runtime)
    : runtime.linkDeviceLogin
      ? config.runtime?.homePath || homes[harness]
      : undefined;

  const authPath =
    harness === "grok"
      ? grokAuthPath({
          dataDir: homes.dataDir,
          id: config.id,
          runtime: config.runtime ?? {},
          deviceHome: homes.grok,
          deviceAuthPath: homes.grokAuthPath ?? homes.env?.["GROK_AUTH_PATH"],
        })
      : undefined;

  const login = home === undefined ? null : probe.login(harness, home, authPath);

  if (login === undefined) return versioned;

  if (login === null) {
    const problem = ownLogin
      ? "not signed in"
      : runtime.linkDeviceLogin
        ? `no ${HARNESS_NAMES[harness]} login on this device`
        : "device login is turned off for this worker";

    const { resolved: _, ...rest } = versioned;

    return { ...rest, problem, authenticated: false };
  }

  return { ...versioned, auth: login, authenticated: true };
}
