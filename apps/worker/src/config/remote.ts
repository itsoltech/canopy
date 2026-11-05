import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Match } from "effect";
import { decodeJsonObject, isString } from "../providers/json.ts";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ConfigAppliedSchema,
  DeviceLogin,
  Provider,
  ProviderProfileKind,
  type ConfigIssue,
  type ProviderConfig,
  type WorkerConfig,
} from "@canopy/contracts";
import {
  ProfileError,
  resolveProfiles,
  toProfileReport,
  type NativeToolPolicy,
  providersOf,
  type ProfileStatus,
  type ProviderProfileConfig,
} from "../providers/index.ts";
import { CLIS, discoverCli, findCli, systemCliProbe, type CliProbe } from "../cli-tools/discovery.ts";
import { shellEnvReady } from "../cli-tools/shell-env.ts";

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
      chosen.set(spec.name, found.path);
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
  /** Codex: link the device owner's login into the worker's isolated CODEX_HOME (default yes). */
  readonly linkDeviceLogin: boolean;
  /** Resolved executable, when enabled and found. */
  readonly executable?: string;
  readonly version?: string;
  readonly problem?: string;
}

export interface AppliedConfig {
  readonly version: bigint;
  readonly claude: ProviderRuntime;
  readonly codex: ProviderRuntime;
  readonly grok: ProviderRuntime;
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
  login?(harness: "claude" | "codex" | "grok", home: string): string | null | undefined;
}

/** Where provider instances live on the device (global provider instances, docs/worker-config.md, section 9). */
export interface DeviceHomes {
  /** The worker's data dir: default shadow homes of instances with their own login. */
  readonly dataDir: string;
  /** The device owner's CLI homes (the login linked by default). */
  readonly claude: string;
  readonly codex: string;
  readonly grok?: string;
  /** The worker process's environment (keys a native Claude may take from it). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The isolated home of an instance with its own login or login source when no shadow home is set. */
export function instanceHome(dataDir: string, harness: "claude" | "codex" | "grok", id: string): string {
  return join(dataDir, "homes", `${harness}-${id}`);
}

/**
 * The isolated home an instance runs with: its shadow home, else its own one when it keeps its own login or links
 * another login (two logins cannot share a home), else undefined = the worker's shared home.
 */
export function instanceShadowHome(
  dataDir: string,
  harness: "claude" | "codex" | "grok",
  id: string,
  runtime: { readonly shadowHomePath?: string; readonly homePath?: string; readonly ownLogin?: boolean } | undefined,
): string | undefined {
  if (runtime?.shadowHomePath) return runtime.shadowHomePath;

  return runtime?.ownLogin || runtime?.homePath ? instanceHome(dataDir, harness, id) : undefined;
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
  login: (harness, home) => {
    if (harness === "claude") {
      if (existsSync(join(home, ".credentials.json"))) return "Claude account";

      return process.platform === "darwin" ? undefined : null;
    }

    const file = join(home, "auth.json");

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

  let profiles: ProfileStatus[] = [];

  try {
    profiles = resolveProfiles(
      config.profiles.map((p, i) => profileConfig(p, i, issue)).filter((p) => p !== undefined),
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
  const runtimes = { claude, codex, grok };
  profiles = profiles.flatMap(perHarness).map((status) => inspectProfile(status, runtimes, probe, homes, config));

  // A configured instance executable also works on a machine with no default CLI
  // on PATH. Instances without their own executable keep the missing-CLI status.
  for (const name of ["claude", "codex", "grok"] as const) {
    if (
      !runtimes[name].enabled &&
      profiles.some((status) => status.resolved && providersOf(status.config).includes(name))
    ) {
      const { problem: _, ...available } = runtimes[name];
      runtimes[name] = { ...available, enabled: true };
    }
  }

  const limits = config.limits;

  const report = {
    version: config.version,
    issues,
    profiles: profiles.map(toProfileReport),
    providers: [
      providerInfo(Provider.CLAUDE, runtimes.claude),
      providerInfo(Provider.CODEX, runtimes.codex),
      providerInfo(Provider.GROK, runtimes.grok),
    ],
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

function providerRuntime(
  name: "claude" | "codex" | "grok",
  config: ProviderConfig | undefined,
  probe: DeviceProbe,
  issue: (path: string, message: string) => void,
): ProviderRuntime {
  const linkDeviceLogin = config?.deviceLogin !== DeviceLogin.NONE;

  if (!config?.enabled) return { enabled: false, linkDeviceLogin, problem: "disabled in configuration" };
  const executable = config.executablePath || probe.which(name);

  if (!executable) {
    const problem = name === "claude" ? "Claude Code is not installed on this computer" : `${name} CLI not found`;
    issue(`${name}.executable_path`, name === "claude" ? problem : `${name} CLI not found on PATH`);

    return { enabled: false, linkDeviceLogin, problem };
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

/**
 * What the device says about an instance: its CLI version (its own executable, else the provider's) and how it
 * authenticates. A provider that is off or missing, an executable that does not run and a native instance without
 * any login make it unavailable (pickers leave it out); an endpoint authenticates with its key.
 */
function perHarness(status: ProfileStatus): ProfileStatus[] {
  const harnesses = providersOf(status.config);

  if (harnesses.length < 2) return [status];

  return harnesses.map((harness) => ({
    ...status,
    config: { ...status.config, providers: [harness] },
    ...(status.resolved && { resolved: { ...status.resolved, providers: [harness] } }),
  }));
}

function inspectProfile(
  status: ProfileStatus,
  runtimes: Record<"claude" | "codex" | "grok", ProviderRuntime>,
  probe: DeviceProbe,
  homes: DeviceHomes | undefined,
  providers: WorkerConfig,
): ProfileStatus {
  const { config } = status;

  if (config.disabled) return status;
  const harness = providersOf(config)[0]!;
  let runtime = runtimes[harness];
  const own = config.runtime?.executablePath;

  if (
    !runtime.enabled &&
    own &&
    runtime.problem ===
      (harness === "claude" ? "Claude Code is not installed on this computer" : `${harness} CLI not found`)
  ) {
    runtime = providerRuntime(harness, { ...providers[harness]!, executablePath: own }, probe, () => {});
  }

  let version = runtime.version;

  if (!runtime.enabled) return { config, problem: runtime.problem ?? `${harness} is disabled` };

  if (own) {
    const line = probe.version(own);

    if (line === undefined) return { config, problem: `${own} not found or not runnable` };
    version = line.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? version;
  }

  const versioned = { ...status, ...(version !== undefined && { version }) };

  if (config.kind === "cliproxyapi")
    return status.resolved
      ? { ...versioned, auth: "endpoint key", authenticated: true }
      : { ...versioned, authenticated: false };

  if (!status.resolved || !homes || !probe.login) return versioned;

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

  const login = home === undefined ? null : probe.login(harness, home);

  if (login === undefined) return versioned;

  if (login === null) {
    const problem = ownLogin
      ? "not signed in"
      : runtime.linkDeviceLogin
        ? `no ${Match.value(harness).pipe(
            Match.when("claude", () => "Claude"),
            Match.when("grok", () => "Grok"),
            Match.orElse(() => "Codex"),
          )} login on this device`
        : "device login is turned off for this worker";

    const { resolved: _, ...rest } = versioned;

    return { ...rest, problem, authenticated: false };
  }

  return { ...versioned, auth: login, authenticated: true };
}

function profileConfig(
  profile: WorkerConfig["profiles"][number],
  index: number,
  issue: (path: string, message: string, fatal?: boolean) => void,
): ProviderProfileConfig | undefined {
  const common = {
    id: profile.id,
    ...(profile.providers.length > 0 && {
      providers: profile.providers.map((p) =>
        Match.value(p).pipe(
          Match.when(Provider.CLAUDE, () => "claude" as const),
          Match.when(Provider.GROK, () => "grok" as const),
          Match.orElse(() => "codex" as const),
        ),
      ),
    }),
    ...(profile.displayName && { displayName: profile.displayName }),
    ...(profile.env.length > 0 && {
      env: profile.env.map((v) => ({ name: v.name, value: v.value, secret: v.secret })),
    }),
    ...(profile.disabled && { disabled: true }),
    ...((profile.executablePath ||
      profile.homePath ||
      profile.shadowHomePath ||
      profile.launchArgs.length > 0 ||
      profile.ownLogin) && {
      runtime: {
        ...(profile.executablePath && { executablePath: profile.executablePath }),
        ...(profile.homePath && { homePath: profile.homePath }),
        ...(profile.shadowHomePath && { shadowHomePath: profile.shadowHomePath }),
        ...(profile.launchArgs.length > 0 && { launchArgs: [...profile.launchArgs] }),
        ...(profile.ownLogin && { ownLogin: true }),
      },
    }),
  };

  switch (profile.kind) {
    case ProviderProfileKind.NATIVE:
      return { kind: "native", ...common };
    case ProviderProfileKind.CLIPROXYAPI:
      return {
        kind: "cliproxyapi",
        ...common,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        ...(profile.proxyCodex && { codex: profile.proxyCodex }),
      };
    default:
      issue(`profiles[${index}].kind`, `unsupported profile kind for "${profile.id}"`);

      return undefined;
  }
}
