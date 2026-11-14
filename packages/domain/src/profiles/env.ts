/**
 * Environment variables of a provider profile (docs/worker-config.md, "Zmienne środowiskowe profilu"). The same
 * rules run in the UI (form hints), the gateway (rejects the save) and the worker (disables the profile), so a
 * configuration written past the gateway cannot override what the worker controls either.
 */

export type ProfileKind = "native" | "endpoint";

export interface ProfileEnvVarRule {
  readonly name: string;
  readonly value: string;
}

export const MAX_PROFILE_ENV_VARS = 64;
export const MAX_ENV_NAME_LENGTH = 128;
export const MAX_ENV_VALUE_LENGTH = 32 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variables the worker sets for every harness process: the isolated homes, the user's home and search path,
 * the SDK's own markers and the worker's own settings. Matched case-insensitively (Windows env is).
 */
const ALWAYS_DENIED = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "PWD",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
  "CLAUDE_CODE_ENTRYPOINT",
  "GROK_HOME",
  "GROK_AUTH_PATH",
  "GROK_AUTH",
  "GROK_CONFIG",
  "GROK_CONFIG_PATH",
] as const;

/**
 * Prefix owned by the platform: the Codex key variables of endpoint profiles (CANOPY_<ID>_API_KEY) and the
 * worker's own settings (CANOPY_*).
 */
const DENIED_PREFIXES = ["CANOPY_"] as const;

/** An endpoint profile sets its own endpoint and key; these would compete with it. */
const ENDPOINT_DENIED = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_XAI_API_BASE_URL",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "GROK_MODELS_BASE_URL",
  "GROK_MODELS_LIST_URL",
  "GROK_AUTH_PROVIDER_COMMAND",
] as const;

/** Names a profile of this kind may not set; for docs and the UI. */
export function deniedEnvNames(kind: ProfileKind): readonly string[] {
  return kind === "endpoint" ? [...ALWAYS_DENIED, ...ENDPOINT_DENIED] : ALWAYS_DENIED;
}

export const deniedEnvPrefixes: readonly string[] = DENIED_PREFIXES;

/** Why this name cannot be used, or undefined when it can. */
export function envNameProblem(kind: ProfileKind, name: string): string | undefined {
  if (!name) return "Enter a variable name.";

  if (name.length > MAX_ENV_NAME_LENGTH) return `Use a name with ${MAX_ENV_NAME_LENGTH} characters or fewer.`;

  if (!ENV_NAME.test(name)) return "Use letters, digits and underscores. Start with a letter or underscore.";
  const upper = name.toUpperCase();

  if (deniedEnvNames(kind).includes(upper)) {
    return ENDPOINT_DENIED.some((denied) => denied === upper)
      ? `${name} comes from this instance's connection. Pick or edit a proxy in Connection instead.`
      : `Canopy sets ${name} for this agent CLI, so each instance keeps its own login and sessions. Change the home or CLI path in Runtime instead.`;
  }

  const prefix = DENIED_PREFIXES.find((p) => upper.startsWith(p));

  if (prefix) return `Names starting with ${prefix} are reserved for Canopy itself. Use a different prefix.`;

  return undefined;
}

/** Problems of a whole list (first one per variable, by index), e.g. duplicates and sizes. */
export function envListProblems(
  kind: ProfileKind,
  vars: readonly ProfileEnvVarRule[],
): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = [];

  if (vars.length > MAX_PROFILE_ENV_VARS)
    problems.push({ index: MAX_PROFILE_ENV_VARS, message: `Use ${MAX_PROFILE_ENV_VARS} variables or fewer.` });
  const seen = new Set<string>();
  vars.forEach((v, index) => {
    const problem =
      envNameProblem(kind, v.name) ??
      (seen.has(v.name.toUpperCase()) ? `${v.name} is already in this list. Use a different name.` : undefined) ??
      (v.value.length > MAX_ENV_VALUE_LENGTH
        ? `${v.name}: use a value with ${MAX_ENV_VALUE_LENGTH} characters or fewer.`
        : undefined) ??
      (v.value.includes("\0") ? `${v.name}: remove the NUL character from the value.` : undefined);

    seen.add(v.name.toUpperCase());

    if (problem) problems.push({ index, message: problem });
  });

  return problems;
}
