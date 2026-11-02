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
const ALWAYS_DENIED = ["HOME", "USERPROFILE", "PATH", "PWD", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_ENTRYPOINT"] as const;

/**
 * Prefix owned by the platform: the Codex key variables of endpoint profiles (OPENAGENTS_<ID>_API_KEY). The
 * worker's own settings (OA_*) are read by the worker process only, so a harness variable of that name is harmless.
 */
const DENIED_PREFIXES = ["OPENAGENTS_"] as const;

/** An endpoint profile sets its own endpoint and key; these would compete with it. */
const ENDPOINT_DENIED = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** Names a profile of this kind may not set; for docs and the UI. */
export function deniedEnvNames(kind: ProfileKind): readonly string[] {
  return kind === "endpoint" ? [...ALWAYS_DENIED, ...ENDPOINT_DENIED] : ALWAYS_DENIED;
}

export const deniedEnvPrefixes: readonly string[] = DENIED_PREFIXES;

/** Why this name cannot be used, or undefined when it can. */
export function envNameProblem(kind: ProfileKind, name: string): string | undefined {
  if (!name) return "name is required";
  if (name.length > MAX_ENV_NAME_LENGTH) return `name is longer than ${MAX_ENV_NAME_LENGTH} characters`;
  if (!ENV_NAME.test(name)) return "use letters, digits and _ (not starting with a digit)";
  const upper = name.toUpperCase();
  if (deniedEnvNames(kind).includes(upper)) {
    return (ENDPOINT_DENIED as readonly string[]).includes(upper)
      ? `${name} is set by the profile's endpoint and key`
      : `${name} is controlled by the worker`;
  }
  const prefix = DENIED_PREFIXES.find((p) => upper.startsWith(p));
  if (prefix) return `${prefix}* variables are reserved for the platform`;
  return undefined;
}

/** Problems of a whole list (first one per variable, by index), e.g. duplicates and sizes. */
export function envListProblems(kind: ProfileKind, vars: readonly ProfileEnvVarRule[]): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = [];
  if (vars.length > MAX_PROFILE_ENV_VARS) problems.push({ index: MAX_PROFILE_ENV_VARS, message: `at most ${MAX_PROFILE_ENV_VARS} variables` });
  const seen = new Set<string>();
  vars.forEach((v, index) => {
    const problem =
      envNameProblem(kind, v.name) ??
      (seen.has(v.name.toUpperCase()) ? `${v.name} is listed twice` : undefined) ??
      (v.value.length > MAX_ENV_VALUE_LENGTH ? `${v.name}: value is longer than ${MAX_ENV_VALUE_LENGTH} characters` : undefined) ??
      (v.value.includes("\0") ? `${v.name}: value contains a NUL character` : undefined);
    seen.add(v.name.toUpperCase());
    if (problem) problems.push({ index, message: problem });
  });
  return problems;
}
