import type { Env, ResolvedProfile } from "../profiles.ts";
import { codexNativeToolOverrides, DEFAULT_NATIVE_TOOL_POLICY, type NativeToolPolicy } from "../native-tools.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";

/**
 * Codex runs as one long-lived `codex app-server` per worker (JSON-RPC over stdio).
 * CLIProxyAPI profiles become extra model providers via `-c` overrides at spawn time;
 * each thread then picks one with `thread/start { modelProvider }`.
 * A profile with its own environment variables gets its own app-server (same CODEX_HOME), started with them:
 * the variables belong to the process, so one process cannot carry two profiles' sets (runtime/host.ts).
 * The device owner's ~/.codex/config.toml is never modified.
 */
export interface CodexAppServerLaunch {
  readonly command: readonly string[];
  readonly env: Record<string, string | undefined>;
}

export function codexAppServerLaunch(
  profiles: readonly ResolvedProfile[],
  baseEnv: Env,
  codexBin = "codex",
  nativeTools: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
  /**
   * Isolated Codex home for platform agents (CODEX_HOME). Without it Codex reads the device owner's
   * ~/.codex: their config, MCP servers, plugins and hooks apply to platform threads too.
   */
  codexHome?: string,
  /** The profile's own variables (a process that serves one profile with variables). */
  profileEnv: Readonly<Record<string, string>> = {},
  /** Launch arguments of the instance (a process that serves one instance with its own runtime). */
  extraArgs: readonly string[] = [],
): CodexAppServerLaunch {
  if (codexHome) managedPlugins(codexHome, "codex");
  const command = [codexBin, "app-server", ...codexNativeToolOverrides(nativeTools), ...extraArgs];

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...profileEnv,
    ...(codexHome !== undefined && { CODEX_HOME: codexHome }),
  };

  for (const profile of profiles) {
    if (profile.kind !== "cliproxyapi" || !profile.providers.includes("codex")) continue;
    const provider = codexModelProviderId(profile);
    const keyEnv = `${provider.toUpperCase()}_API_KEY`;

    const settings = {
      name: `CLIProxyAPI (${profile.id})`,
      base_url: new URL("v1", withTrailingSlash(profile.baseUrl)).href,
      wire_api: "responses",
      // Sent as `Authorization: Bearer $KEY`. The key goes through env, never argv.
      env_key: keyEnv,
      requires_openai_auth: false,
    } satisfies Record<string, string | boolean>;

    for (const [key, value] of Object.entries(settings)) {
      command.push("-c", `model_providers.${provider}.${key}=${tomlValue(value)}`);
    }

    env[keyEnv] = profile.apiKey;
  }

  return { command, env };
}

/** `thread/start` fields for a profile. Native keeps the device's own Codex config. */
export function codexThreadProvider(profile: ResolvedProfile): { modelProvider?: string } {
  return profile.kind === "cliproxyapi" ? { modelProvider: codexModelProviderId(profile) } : {};
}

/** Prefixed so it cannot collide with providers from the device owner's config.toml. */
export function codexModelProviderId(profile: ResolvedProfile): string {
  return `canopy_${profile.id.replace(/-/g, "_")}`;
}

function withTrailingSlash(url: URL): URL {
  return url.pathname.endsWith("/") ? url : new URL(`${url.href}/`);
}

/** TOML literal for `-c key=value`. JSON string escapes are valid TOML basic strings. */
function tomlValue(value: string | boolean): string {
  return JSON.stringify(value);
}
