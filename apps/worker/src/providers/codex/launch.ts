import type { Env, ResolvedProfile } from "../profiles.ts";
import { codexNativeToolOverrides, DEFAULT_NATIVE_TOOL_POLICY, type NativeToolPolicy } from "../native-tools.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";
import { pluginIndexPath } from "../../agent-environment/plugin-config.ts";
import { lstatSync } from "node:fs";
import { Predicate } from "effect";
import { deviceSkillOverrides } from "./skills.ts";

/**
 * Codex runs as one long-lived `codex app-server` per instance (JSON-RPC over stdio).
 * CLIProxyAPI profiles become extra model providers via `-c` overrides at spawn time;
 * each thread then picks one with `thread/start { modelProvider }`.
 * Each instance drains and replaces its process independently, preserving CODEX_HOME across connection changes.
 * The device owner's ~/.codex/config.toml is never modified.
 */
export interface CodexAppServerLaunch {
  readonly command: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cliHomes?: CodexCliHomes;
}

interface CodexCliHomes {
  readonly cliHome: string;
  readonly privateHome: string;
}

/** Check the private deployment on every launch/start. The CLI's own configuration can be large or symlinked. */
export function checkCodexPlugins(home: string | CodexCliHomes): void {
  if (Predicate.isString(home)) {
    managedPlugins(home, "codex");

    return;
  }

  managedPlugins(home.privateHome, "codex");

  if (lstatSync(pluginIndexPath(home.cliHome, "codex"), { throwIfNoEntry: false }))
    managedPlugins(home.cliHome, "codex");
}

export function codexThreadLaunchArgs(extraArgs: readonly string[] = []): readonly string[] {
  // The isolated CODEX_HOME has no Windows sandbox setup by default. Use Codex's unelevated
  // backend fallback so explicit windows.sandbox settings and managed requirements still win.
  return process.platform === "win32" ? ["-c", "features.experimental_windows_sandbox=true", ...extraArgs] : extraArgs;
}

export function codexAppServerLaunch(
  profiles: readonly ResolvedProfile[],
  baseEnv: Env,
  codexBin = "codex",
  nativeTools: NativeToolPolicy = DEFAULT_NATIVE_TOOL_POLICY,
  /** A private CODEX_HOME, or the explicit CLI home with its separate Canopy deployment. */
  codexHome?: string | CodexCliHomes,
  /** The profile's own variables (a process that serves one profile with variables). */
  profileEnv: Readonly<Record<string, string>> = {},
  /** Launch arguments of the instance (a process that serves one instance with its own runtime). */
  extraArgs: readonly string[] = [],
): CodexAppServerLaunch {
  const cliHomes = Predicate.isString(codexHome) ? undefined : codexHome;
  const path = Predicate.isString(codexHome) ? codexHome : cliHomes?.cliHome;

  if (cliHomes && (profiles.length !== 1 || profiles[0]?.kind !== "native"))
    throw new Error("Only a single native Codex instance may run in the CLI home.");

  if (codexHome) checkCodexPlugins(codexHome);
  const [instance, ...others] = profiles.filter((profile) => profile.providers.includes("codex"));
  const settings = others.length === 0 ? instance?.runtime.codexSettings : undefined;

  const command = [
    codexBin,
    "app-server",
    ...codexNativeToolOverrides(nativeTools),
    ...Object.entries(settings ?? {}).flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]),
    ...extraArgs,
  ];

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...profileEnv,
    ...(path !== undefined && { CODEX_HOME: path }),
  };

  if (Predicate.isString(codexHome)) command.push(...deviceSkillOverrides(env));

  // Each production runtime serves one instance. Codex also checks the process's current provider when
  // admitting turns: selecting a provider only on thread/start or thread/resume is not enough.
  if (instance && others.length === 0) {
    command.push("-c", `model_provider=${tomlValue(codexThreadProvider(instance).modelProvider)}`);

    if (instance.kind === "cliproxyapi") command.push("-c", "features.unbounded_connection_retries=false");
  }

  for (const profile of profiles) {
    if (profile.kind !== "cliproxyapi" || !profile.providers.includes("codex")) continue;
    const provider = codexModelProviderId(profile);
    const keyEnv = `${provider.toUpperCase()}_API_KEY`;
    const websockets = profile.codex?.supportsWebsockets ?? false;

    const settings = {
      name: `CLIProxyAPI (${profile.id})`,
      base_url: new URL("v1", withTrailingSlash(profile.baseUrl)).href,
      wire_api: profile.codex?.wireApi || "responses",
      // Sent as `Authorization: Bearer $KEY`. The key goes through env, never argv.
      env_key: keyEnv,
      requires_openai_auth: false,
      // HTTP/SSE avoids proxy control-frame races; WebSockets require an explicit capability choice.
      supports_websockets: websockets,
      // Codex retries the sampling step inside the current turn. A WebSocket → HTTP fallback
      // starts a fresh counter, so budget five attempts per transport or ten for HTTP alone.
      stream_max_retries: websockets ? 4 : 9,
      request_max_retries: 0,
    } satisfies Record<string, string | boolean | number>;

    for (const [key, value] of Object.entries(settings)) {
      command.push("-c", `model_providers.${provider}.${key}=${tomlValue(value)}`);
    }

    for (const [header, value] of Object.entries(profile.codex?.extraHeaders ?? {})) {
      command.push("-c", `model_providers.${provider}.http_headers.${JSON.stringify(header)}=${tomlValue(value)}`);
    }

    env[keyEnv] = profile.apiKey;
  }

  return { command, env, ...(cliHomes && { cliHomes }) };
}

/** Also sent on resume: omitting the native provider would retain the rollout's previous proxy. */
export function codexThreadProvider(profile: ResolvedProfile) {
  return { modelProvider: profile.kind === "cliproxyapi" ? codexModelProviderId(profile) : "openai" };
}

/** Prefixed so it cannot collide with providers from the device owner's config.toml. */
export function codexModelProviderId(profile: ResolvedProfile): string {
  return `canopy_${profile.id.replace(/-/g, "_")}`;
}

function withTrailingSlash(url: URL): URL {
  return url.pathname.endsWith("/") ? url : new URL(`${url.href}/`);
}

/** TOML literal for `-c key=value`. JSON string escapes are valid TOML basic strings. */
function tomlValue(value: string | boolean | number): string {
  return JSON.stringify(value);
}
