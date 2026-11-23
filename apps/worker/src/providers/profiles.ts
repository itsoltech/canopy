import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  Provider,
  ProviderProfileKind,
  type ProviderProfileSchema,
  type ProviderUserConfiguration,
  type ProxyCodexOptions,
} from "@canopy/contracts";
import { envListProblems } from "@canopy/domain";
import type {
  ClaudeProviderSettings,
  CodexProviderSettings,
  GrokProviderSettings,
} from "@canopy/domain/provider-settings";
import { Match } from "effect";
import { sandboxSupport } from "./sandbox-support.ts";

/**
 * Provider profiles come from the remote worker configuration (WorkerConfig.profiles, docs/worker-config.md).
 * Threads pick one by id (ThreadSpec.provider_profile_id). The API key and secret variables arrive from the
 * gateway and are kept in memory only: never written to disk, never put in argv or logs.
 */
export type ProviderProfileConfig = NativeProfileConfig | CliProxyApiProfileConfig;

interface ProfileConfigBase {
  readonly id: string;
  /** Defaults to both providers. */
  readonly providers?: readonly ("claude" | "codex" | "grok")[];
  /** Shown in the UI; empty = id. */
  readonly displayName?: string;
  /** Environment of the profile's harness process (docs/worker-config.md); values may be secrets. */
  readonly env?: readonly ProfileEnvVarConfig[];
  /** Turned off by the user: unavailable. */
  readonly disabled?: boolean;
  /** Safe validation error for CLI settings received from the gateway. */
  readonly settingsProblem?: string;
  /**
   * How the harness of this instance runs. When absent, the built-in Codex device login uses its CLI home.
   * Other instances use their worker defaults (docs/worker-config.md, section 9).
   */
  readonly runtime?: ProfileRuntimeConfig;
}

export interface ProfileRuntimeConfig {
  readonly userConfiguration?: ProfileUserConfiguration;
  readonly claudeSettings?: ClaudeProviderSettings;
  readonly codexSettings?: CodexProviderSettings;
  readonly grokSettings?: GrokProviderSettings;
  /** The harness executable of this instance (else the provider's). */
  readonly executablePath?: string;
  /** The device owner's CLI home the login is linked from (else the worker's CODEX_HOME / CLAUDE_CONFIG_DIR, ~). */
  readonly homePath?: string;
  /** The isolated home the harness runs with (else <data_dir>/codex-home, claude-home). */
  readonly shadowHomePath?: string;
  readonly launchArgs?: readonly string[];
  /** The instance's own login kept in its shadow home (no device login linked). */
  readonly ownLogin?: boolean;
}

export type ProfileUserConfiguration = Pick<
  ProviderUserConfiguration,
  "mode" | "sourcePath" | "instructions" | "skills" | "hooks"
>;

export interface ProfileEnvVarConfig {
  readonly name: string;
  readonly value: string;
  readonly secret?: boolean;
}

export interface NativeProfileConfig extends ProfileConfigBase {
  readonly kind: "native";
}

export interface CliProxyApiProfileConfig extends ProfileConfigBase {
  readonly codex?: Omit<ProxyCodexOptions, "$typeName">;
  readonly kind: "cliproxyapi";
  /** CLIProxyAPI root, e.g. http://127.0.0.1:8317 (Claude uses the root, Codex `<root>/v1`). */
  readonly baseUrl: string;
  /** A key from CLIProxyAPI `api-keys`. Empty = profile unavailable. */
  readonly apiKey: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

interface ResolvedBase {
  readonly id: string;
  readonly providers: readonly ("claude" | "codex" | "grok")[];
  /** The profile's own variables, applied over the worker's environment (validated, may hold secrets). */
  readonly env: Readonly<Record<string, string>>;
  readonly runtime: ProfileRuntimeConfig;
}

/** A profile with its secrets resolved. Lives only in worker memory. */
export type ResolvedProfile =
  | (ResolvedBase & { readonly kind: "native" })
  | (ResolvedBase & {
      readonly kind: "cliproxyapi";
      readonly baseUrl: URL;
      readonly apiKey: string;
      readonly codex?: Omit<ProxyCodexOptions, "$typeName">;
    });

export const NATIVE_PROFILE: NativeProfileConfig = { kind: "native", id: "native" };

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// Legacy profiles without an explicit provider list keep their original meaning.
const BOTH = ["claude", "codex"] as const;
const ALL = [...BOTH, "grok"] as const;

export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

export interface ProfileStatus {
  readonly config: ProviderProfileConfig;
  /** Undefined when the profile cannot be used (see `problem`). */
  readonly resolved?: ResolvedProfile;
  readonly problem?: string;
  /** What the device says about the instance (config/remote.ts): its CLI version and how it authenticates. */
  readonly version?: string;
  readonly auth?: string;
  readonly authenticated?: boolean;
  readonly loginHomePath?: string;
  /** Metadata of the native Codex login when the worker last applied or probed this configuration. */
  readonly codexLoginRevision?: string;
  readonly configurationHomePath?: string;
  readonly sessionHomePath?: string;
  readonly privateHomePath?: string;
}

/** The instance overrides the worker's executable, home, login or launch arguments. */
export function hasOwnRuntime(runtime: ProfileRuntimeConfig): boolean {
  return Boolean(
    runtime.executablePath ||
    runtime.homePath ||
    runtime.shadowHomePath ||
    runtime.launchArgs?.length ||
    runtime.userConfiguration ||
    runtime.claudeSettings ||
    runtime.codexSettings ||
    runtime.grokSettings ||
    runtime.ownLogin,
  );
}

export const providersOf = (
  config: Pick<ProviderProfileConfig, "providers">,
): readonly ("claude" | "codex" | "grok")[] => (config.providers?.length ? config.providers : BOTH);

/**
 * Validates configs. Invalid ids and endpoints throw (fatal); a missing key, a variable the worker controls or
 * a disabled profile mark only that profile unavailable.
 */
export function resolveProfiles(configs: readonly ProviderProfileConfig[]): ProfileStatus[] {
  // The built-in native profile for every provider the configuration gives none (an instance per provider, or both).
  const nativeFor = ALL.filter(
    (provider) => !configs.some((c) => c.id === NATIVE_PROFILE.id && providersOf(c).includes(provider)),
  );

  const all = nativeFor.length === 0 ? configs : [{ ...NATIVE_PROFILE, providers: nativeFor }, ...configs];
  const seen = new Set<string>();

  return all.map((config): ProfileStatus => {
    if (!PROFILE_ID.test(config.id)) throw new ProfileError(`invalid profile id "${config.id}"`);

    // One instance per provider and id: the same id may serve the other provider as its own instance.
    for (const provider of providersOf(config)) {
      if (seen.has(`${provider}/${config.id}`)) throw new ProfileError(`duplicate profile id "${config.id}"`);
      seen.add(`${provider}/${config.id}`);
    }

    // Turned off: unused, so not validated further (a stub without endpoint or key).
    if (config.disabled) return { config, problem: "disabled" };

    if (config.settingsProblem) return { config, problem: config.settingsProblem };

    let baseUrl: URL | undefined;

    if (config.kind === "cliproxyapi") {
      try {
        baseUrl = new URL(config.baseUrl);
      } catch {
        throw new ProfileError(`profile "${config.id}": invalid baseUrl "${config.baseUrl}"`);
      }

      if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
        throw new ProfileError(`profile "${config.id}": baseUrl must be http(s)`);
      }

      if (baseUrl.username || baseUrl.password) {
        throw new ProfileError(`profile "${config.id}": put credentials in api_key, not in base_url`);
      }

      baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") || "/";
    }

    const vars = config.env ?? [];
    // Only the name goes into the problem: values may be secrets.
    const envProblem = envListProblems(config.kind === "native" ? "native" : "endpoint", vars)[0];

    if (envProblem) return { config, problem: `env: ${envProblem.message}` };
    const runtime = config.runtime ?? {};

    const base = {
      id: config.id,
      providers: providersOf(config),
      env: Object.fromEntries(vars.map((v) => [v.name, v.value])),
      runtime,
    };

    if (config.kind === "native") return { config, resolved: { kind: "native", ...base } };

    if (!config.apiKey) return { config, problem: "api_key is not set" };

    return {
      config,
      resolved: {
        kind: "cliproxyapi",
        ...base,
        baseUrl: baseUrl!,
        apiKey: config.apiKey,
        ...(config.codex && { codex: config.codex }),
      },
    };
  });
}

/** ConfigApplied.profiles entry. Contains no secrets (no key, no variable values). */
export function toProfileReport(status: ProfileStatus): MessageInitShape<typeof ProviderProfileSchema> {
  const { config } = status;

  const providers = providersOf(config).map((p) =>
    Match.value(p).pipe(
      Match.when("claude", () => Provider.CLAUDE),
      Match.when("grok", () => Provider.GROK),
      Match.orElse(() => Provider.CODEX),
    ),
  );

  const [provider] = providers;

  return {
    id: config.id,
    kind: config.kind === "native" ? ProviderProfileKind.NATIVE : ProviderProfileKind.CLIPROXYAPI,
    providers,
    ...(providers.length === 1 && provider !== undefined && { sandboxSupport: sandboxSupport(provider, status) }),
    ...(config.kind === "cliproxyapi" && URL.canParse(config.baseUrl) && { endpoint: new URL(config.baseUrl).origin }),
    available: status.resolved !== undefined,
    ...(status.problem !== undefined && { detail: status.problem }),
    ...(config.displayName && { displayName: config.displayName }),
    ...(status.version && { version: status.version }),
    ...(status.auth && { auth: status.auth }),
    ...(status.authenticated && { authenticated: true }),
    loginHomePath: status.loginHomePath ?? "",
    configurationHomePath: status.configurationHomePath ?? "",
    sessionHomePath: status.sessionHomePath ?? "",
    privateHomePath: status.privateHomePath ?? "",
  };
}

/** Profile for ThreadSpec.provider_profile_id ("" = native). Throws when unknown, unavailable or not for this provider. */
export function selectProfile(
  statuses: readonly ProfileStatus[],
  profileId: string,
  provider: "claude" | "codex" | "grok",
): ResolvedProfile {
  const id = profileId || NATIVE_PROFILE.id;
  const ofId = statuses.filter((s) => s.config.id === id);

  if (ofId.length === 0) throw new ProfileError(`unknown provider profile "${id}"`);
  const status = ofId.find((s) => providersOf(s.config).includes(provider));

  if (!status) throw new ProfileError(`provider profile "${id}" is not enabled for ${provider}`);

  if (!status.resolved) throw new ProfileError(`provider profile "${id}" is unavailable: ${status.problem ?? "?"}`);

  return status.resolved;
}
