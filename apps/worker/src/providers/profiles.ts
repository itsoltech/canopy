import type { MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, type ProviderProfileSchema } from "@open-agents/contracts";

/**
 * Provider profiles are defined by the device owner in the worker's local config.
 * The gateway only sees ids (Hello.profiles) and picks one per thread (ThreadSpec.provider_profile_id).
 * Secrets are referenced by env var name and never leave the device.
 */
export type ProviderProfileConfig = NativeProfileConfig | CliProxyApiProfileConfig;

export interface NativeProfileConfig {
  readonly kind: "native";
  readonly id: string;
}

export interface CliProxyApiProfileConfig {
  readonly kind: "cliproxyapi";
  readonly id: string;
  /** CLIProxyAPI root, e.g. http://127.0.0.1:8317 (Claude uses the root, Codex `<root>/v1`). */
  readonly baseUrl: string;
  /** Env var holding a key from CLIProxyAPI `api-keys`. */
  readonly apiKeyEnv: string;
  /** Defaults to both providers. */
  readonly providers?: readonly ("claude" | "codex")[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** A profile with its secret resolved. Lives only in worker memory. */
export type ResolvedProfile =
  | { readonly kind: "native"; readonly id: string }
  | {
      readonly kind: "cliproxyapi";
      readonly id: string;
      readonly baseUrl: URL;
      readonly apiKey: string;
      readonly providers: readonly ("claude" | "codex")[];
    };

export const NATIVE_PROFILE: NativeProfileConfig = { kind: "native", id: "native" };

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

export interface ProfileStatus {
  readonly config: ProviderProfileConfig;
  /** Undefined when the profile cannot be used (see `problem`). */
  readonly resolved?: ResolvedProfile;
  readonly problem?: string;
}

/** Validates configs and resolves secrets. Invalid configs throw; missing secrets mark the profile unavailable. */
export function resolveProfiles(configs: readonly ProviderProfileConfig[], env: Env): ProfileStatus[] {
  const all = configs.some((c) => c.id === NATIVE_PROFILE.id) ? configs : [NATIVE_PROFILE, ...configs];
  const seen = new Set<string>();
  return all.map((config) => {
    if (!PROFILE_ID.test(config.id)) throw new ProfileError(`invalid profile id "${config.id}"`);
    if (seen.has(config.id)) throw new ProfileError(`duplicate profile id "${config.id}"`);
    seen.add(config.id);
    if (config.kind === "native") return { config, resolved: config };

    let baseUrl: URL;
    try {
      baseUrl = new URL(config.baseUrl);
    } catch {
      throw new ProfileError(`profile "${config.id}": invalid baseUrl "${config.baseUrl}"`);
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new ProfileError(`profile "${config.id}": baseUrl must be http(s)`);
    }
    if (baseUrl.username || baseUrl.password) {
      throw new ProfileError(`profile "${config.id}": put credentials in apiKeyEnv, not in baseUrl`);
    }
    const apiKey = env[config.apiKeyEnv];
    if (!apiKey) return { config, problem: `env ${config.apiKeyEnv} is not set` };
    return {
      config,
      resolved: {
        kind: "cliproxyapi",
        id: config.id,
        baseUrl,
        apiKey,
        providers: config.providers ?? ["claude", "codex"],
      },
    };
  });
}

/** Hello.profiles entry. Contains no secrets. */
export function toHelloProfile(status: ProfileStatus): MessageInitShape<typeof ProviderProfileSchema> {
  const { config } = status;
  if (config.kind === "native") {
    return {
      id: config.id,
      kind: ProviderProfileKind.NATIVE,
      providers: [Provider.CLAUDE, Provider.CODEX],
      available: true,
    };
  }
  return {
    id: config.id,
    kind: ProviderProfileKind.CLIPROXYAPI,
    providers: (config.providers ?? ["claude", "codex"]).map((p) => (p === "claude" ? Provider.CLAUDE : Provider.CODEX)),
    endpoint: new URL(config.baseUrl).origin,
    available: status.resolved !== undefined,
    ...(status.problem !== undefined && { detail: status.problem }),
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
  if (status.resolved.kind === "cliproxyapi" && !status.resolved.providers.includes(provider)) {
    throw new ProfileError(`provider profile "${id}" is not enabled for ${provider}`);
  }
  return status.resolved;
}
