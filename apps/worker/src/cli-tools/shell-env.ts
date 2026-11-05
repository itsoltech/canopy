import { homedir } from "node:os";
import { delimiter } from "node:path";
import { processKey, runProcess } from "@canopy/process-governor";
import { withNodeOnPath } from "./locations.ts";

/**
 * The user's login-shell environment (docs/provider-cli.md). A worker started by a GUI app, launchd or systemd
 * misses what the user's shell profile adds: ~/.bun/bin, ~/.volta/bin, nvm/fnm/mise shims, the npm prefix. The
 * worker asks the user's own shell once (`$SHELL -l -i -c`, through the process governor, with a deadline) and
 * keeps only PATH and the variables package managers read. The shell's PATH entries come first, then the worker's
 * own; any other variable already set on the worker wins over the shell's.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** What is taken from the shell besides PATH: where node and package managers keep their tools. */
export const SHELL_VARIABLES = [
  "BUN_INSTALL",
  "VOLTA_HOME",
  "PNPM_HOME",
  "NVM_DIR",
  "NVM_BIN",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "MISE_DATA_DIR",
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "NPM_CONFIG_USERCONFIG",
  "HOMEBREW_PREFIX",
  "N_PREFIX",
] as const;

export const SHELL_ENV_TIMEOUT_MS = 8_000;
const SHELL_OUTPUT_LIMIT = 1024 * 1024;
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE|AUTH)/i;

const WANTED = ["PATH", ...SHELL_VARIABLES];

/**
 * A POSIX `sh` script the login shell runs (any shell can start one): `name=value` pairs, NUL-separated, so a
 * multi-line value cannot pose as another variable. No single quotes inside: the login shell gets it single-quoted.
 */
const printer = `printf "%s\\000" ${WANTED.map((name) => `"${name}=\${${name}-}"`).join(" ")}`;

/** The variables between the two markers; startup noise before and after is ignored. */
export function parseShellEnv(output: string, marker: string): Record<string, string> | undefined {
  const start = output.indexOf(marker);
  const end = start < 0 ? -1 : output.indexOf(marker, start + marker.length);

  if (start < 0 || end < 0) return undefined;
  const wanted = new Set<string>(WANTED);
  const vars: Record<string, string> = {};

  for (const pair of output.slice(start + marker.length, end).split("\0")) {
    const text = pair.replace(/^\r?\n/, "");
    const at = text.indexOf("=");
    const name = at > 0 ? text.slice(0, at) : "";

    if (wanted.has(name) && text.length > at + 1) vars[name] = text.slice(at + 1);
  }

  return vars;
}

const entries = (path: string | undefined) => (path ?? "").split(delimiter).filter(Boolean);

/** The worker's env with the shell's PATH entries first and its package-manager variables where unset. */
export function mergeShellEnv(env: Env, shell: Readonly<Record<string, string>>) {
  const merged: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) if (value !== undefined) merged[name] = value;

  for (const name of SHELL_VARIABLES) if (!merged[name] && shell[name]) merged[name] = shell[name];
  const path = [...new Set([...entries(shell["PATH"]), ...entries(env["PATH"])])];

  if (path.length > 0) merged["PATH"] = path.join(delimiter);

  return merged;
}

export interface ShellEnvOptions {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly timeoutMs?: number;
}

export type ShellEnvResult =
  | { readonly ok: true; readonly vars: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/** Runs the login shell once. No shell (Windows, no $SHELL, CANOPY_LOGIN_SHELL_ENV=0) is not an error. */
export async function readShellEnv(options: ShellEnvOptions): Promise<ShellEnvResult> {
  const shell = options.env["SHELL"];

  if (options.platform === "win32" || !shell || options.env["CANOPY_LOGIN_SHELL_ENV"] === "0")
    return { ok: false, reason: "no login shell" };
  const marker = `__CANOPY_ENV_${Bun.randomUUIDv7().replaceAll("-", "")}__`;
  // The shell's startup files see neither Canopy's variables nor secret-looking ones.
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(options.env))
    if (value !== undefined && !name.startsWith("CANOPY_") && !SECRET_NAME.test(name)) env[name] = value;
  env["TERM"] = "dumb";
  env["DISABLE_AUTO_UPDATE"] = "true";

  const command = {
    argv: [shell, "-l", "-i", "-c", `echo ${marker}; /bin/sh -c '${printer}'; echo ${marker}`],
    env,
    input: "",
    timeoutMs: options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS,
    maxBytes: SHELL_OUTPUT_LIMIT,
  };

  try {
    const result = await runProcess(command, { kind: "probe", key: processKey(command) });
    const vars = parseShellEnv(result.stdout, marker);

    if (!vars) return { ok: false, reason: `${shell} exited with code ${result.code} before printing its environment` };

    return { ok: true, vars };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

let applied: Promise<ShellEnvResult> | undefined;
let appliedAt = 0;
const REFRESH_MS = 60_000;

/**
 * Resolves the login-shell env once per worker process and merges it into process.env, so discovery, version
 * probes, installers and harness processes all see the same PATH; a node runtime from a known place is appended
 * when PATH has none (JS shims). `refresh` asks the shell again.
 */
export function applyShellEnv(refresh = false): Promise<ShellEnvResult> {
  if (applied && !refresh) return applied;
  const base = { ...process.env };
  appliedAt = Date.now();

  applied = readShellEnv({ env: base, platform: process.platform }).then((result) => {
    const merged = result.ok ? mergeShellEnv(base, result.vars) : { ...base };
    const path = withNodeOnPath({ platform: process.platform, home: homedir(), env: merged });

    if (path) merged["PATH"] = path;

    for (const [name, value] of Object.entries(merged)) if (process.env[name] !== value) process.env[name] = value;

    return result;
  });

  return applied;
}

/** "Check for updates": ask the shell again (only when the worker uses it, at most once a minute). */
export function refreshShellEnv(): Promise<ShellEnvResult | undefined> {
  if (!applied || Date.now() - appliedAt < REFRESH_MS) return shellEnvReady();

  return applyShellEnv(true);
}

/** The pending or finished login-shell lookup, when the worker started one (tests and tools never do). */
export const shellEnvReady = (): Promise<ShellEnvResult | undefined> => applied ?? Promise.resolve(undefined);
