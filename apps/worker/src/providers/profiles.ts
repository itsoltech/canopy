import type { MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, type ProviderProfileSchema } from "@open-agents/contracts";
import { envListProblems } from "@open-agents/domain";

/**
 * Provider profiles come from the remote worker configuration (WorkerConfig.profiles, docs/worker-config.md).
 * Threads pick one by id (ThreadSpec.provider_profile_id). The API key and secret variables arrive from the
 * gateway and are kept in memory only: never written to disk, never put in argv or logs.
 */
export type ProviderProfileConfig = NativeProfileConfig | CliProxyApiProfileConfig;

interface ProfileConfigBase {
  readonly id: string;
  /** Defaults to both providers. */
  readonly providers?: readonly ("claude" | "codex")[];
  /** Shown in the UI; empty = id. */
  readonly displayName?: string;
  /** Environment of the profile's harness process (docs/worker-config.md); values may be secrets. */
  readonly env?: readonly ProfileEnvVarConfig[];
  /** Turned off by the user: unavailable. */
  readonly disabled?: boolean;
}

export interface ProfileEnvVarConfig {
  readonly name: string;
  readonly value: string;
  readonly secret?: boolean;
}

export interface NativeProfileConfig extends ProfileConfigBase {
  readonly kind: "native";
}

export interface CliProxyApiProfileConfig extends ProfileConfigBase {
  readonly kind: "cliproxyapi";
  /** CLIProxyAPI root, e.g. http://127.0.0.1:8317 (Claude uses the root, Codex `<root>/v1`). */
  readonly baseUrl: string;
  /** A key from CLIProxyAPI `api-keys`. Empty = profile unavailable. */
  readonly apiKey: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

interface ResolvedBase {
  readonly id: string;
  readonly providers: readonly ("claude" | "codex")[];
  /** The profile's own variables, applied over the worker's environment (validated, may hold secrets). */
  readonly env: Readonly<Record<string, string>>;
}

/** A profile with its secrets resolved. Lives only in worker memory. */
export type ResolvedProfile =
  | (ResolvedBase & { readonly kind: "native" })
  | (ResolvedBase & { readonly kind: "cliproxyapi"; readonly baseUrl: URL; readonly apiKey: string });

export const NATIVE_PROFILE: NativeProfileConfig = { kind: "native", id: "native" };

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BOTH = ["claude", "codex"] as const;

export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

export interface ProfileStatus {
  readonly config: ProviderProfileConfig;
  /** Undefined when the profile cannot be used (see `problem`). */
  readonly resolved?: ResolvedProfile;
  readonly problem?: string;
}

/**
 * Validates configs. Invalid ids and endpoints throw (fatal); a missing key, a variable the worker controls or
 * a disabled profile mark only that profile unavailable.
 */
export function resolveProfiles(configs: readonly ProviderProfileConfig[]): ProfileStatus[] {
  const all = configs.some((c) => c.id === NATIVE_PROFILE.id) ? configs : [NATIVE_PROFILE, ...configs];
  const seen = new Set<string>();
  return all.map((config): ProfileStatus => {
    if (!PROFILE_ID.test(config.id)) throw new ProfileError(`invalid profile id "${config.id}"`);
    if (seen.has(config.id)) throw new ProfileError(`duplicate profile id "${config.id}"`);
    seen.add(config.id);

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
    }
    if (config.disabled) return { config, problem: "disabled" };
    const vars = config.env ?? [];
    // Only the name goes into the problem: values may be secrets.
    const envProblem = envListProblems(config.kind === "native" ? "native" : "endpoint", vars)[0];
    if (envProblem) return { config, problem: `env: ${envProblem.message}` };
    const base = { id: config.id, providers: config.providers?.length ? config.providers : BOTH, env: Object.fromEntries(vars.map((v) => [v.name, v.value])) };
    if (config.kind === "native") return { config, resolved: { kind: "native", ...base } };
    if (!config.apiKey) return { config, problem: "api_key is not set" };
    return { config, resolved: { kind: "cliproxyapi", ...base, baseUrl: baseUrl!, apiKey: config.apiKey } };
  });
}

/** ConfigApplied.profiles entry. Contains no secrets (no key, no variable values). */
export function toProfileReport(status: ProfileStatus): MessageInitShape<typeof ProviderProfileSchema> {
  const { config } = status;
  return {
    id: config.id,
    kind: config.kind === "native" ? ProviderProfileKind.NATIVE : ProviderProfileKind.CLIPROXYAPI,
    providers: (config.providers?.length ? config.providers : BOTH).map((p) => (p === "claude" ? Provider.CLAUDE : Provider.CODEX)),
    ...(config.kind === "cliproxyapi" && { endpoint: new URL(config.baseUrl).origin }),
    available: status.resolved !== undefined,
    ...(status.problem !== undefined && { detail: status.problem }),
    ...(config.displayName && { displayName: config.displayName }),
  };
}

/** Profile for ThreadSpec.provider_profile_id ("" = native). Throws when unknown, unavailable or not for this provider. */
export function selectProfile(
  statuses: readonly ProfileStatus[],
  profileId: string,
  provider: "claude" | "codex",
): ResolvedProfile {
  const id = profileId || NATIVE_PROFILE.id;
  const status = statuses.find((s) => s.config.id === id);
  if (!status) throw new ProfileError(`unknown provider profile "${id}"`);
  if (!status.resolved) throw new ProfileError(`provider profile "${id}" is unavailable: ${status.problem ?? "?"}`);
  if (!status.resolved.providers.includes(provider)) {
    throw new ProfileError(`provider profile "${id}" is not enabled for ${provider}`);
  }
  return status.resolved;
}
