import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliInstallMethod } from "@canopy/contracts";
import { processGovernor, killProcessTree } from "@canopy/process-governor";
import type { DiscoveredCli } from "./discovery.ts";
import { planRecipe, type Recipe, type RecipeTools } from "./recipes.ts";

/**
 * Runs one fixed recipe (recipes.ts) and makes sure a working CLI is left behind (docs/provider-cli.md): the new
 * executable must answer `--version` (with the requested version when it was exact), else the previous one is put
 * back: the native launcher's symlink is restored, a package is reinstalled at the previous version. Output lines are
 * redacted before they leave this module. The install runs without the worker's secret-looking variables and never
 * touches a CLI's login.
 */

export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const ROLLBACK_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_LIMIT = 2 * 1024 * 1024;
const LINE_LIMIT = 400;

export interface InstallInput {
  readonly before: DiscoveredCli;
  readonly target: string;
  readonly recipe: Recipe;
  readonly tools: RecipeTools;
  /** Where installer scripts are kept while they run (removed afterwards). */
  readonly workDir: string;
  /** The CLI as found after the recipe ran. */
  rediscover(): Promise<DiscoveredCli>;
  onLines(lines: readonly string[]): void;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type InstallOutcome =
  | { readonly ok: true; readonly after: DiscoveredCli }
  | { readonly ok: false; readonly error: string; readonly after: DiscoveredCli };

/** Variables an installer never needs and must not see. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE|AUTH)/i;

export function installEnv(env: Readonly<Record<string, string | undefined>>) {
  const clean: Record<string, string> = {};
  const secrets: string[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;

    if (name.startsWith("CANOPY_") || SECRET_NAME.test(name)) {
      if (value.length >= 8) secrets.push(value);
      continue;
    }

    clean[name] = value;
  }

  return { env: { ...clean, NO_COLOR: "1", CI: "1", npm_config_update_notifier: "false" }, secrets };
}

const PATTERNS = [
  // oxlint-disable-next-line no-control-regex -- Strip ANSI CSI sequences from untrusted installer output.
  [/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""],
  // oxlint-disable-next-line no-control-regex -- Strip ANSI OSC sequences, including their BEL terminator.
  [/\x1b\][^\x07]*\x07/g, ""],
  [/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1***@"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\b(sk|xai|ghp|gho|ghs|ghu|ghr|github_pat|npm|glpat)[-_][A-Za-z0-9_-]{12,}/g, "***"],
  [/\b(token|secret|password|api[_-]?key)=\S+/gi, "$1=***"],
] satisfies readonly [RegExp, string][];

export function redactLine(line: string, secrets: readonly string[]): string {
  // A carriage return redraws a progress line: keep what is shown last.
  let out = line.split("\r").filter(Boolean).at(-1) ?? "";

  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);

  for (const secret of secrets) if (out.includes(secret)) out = out.replaceAll(secret, "***");
  // oxlint-disable-next-line no-control-regex -- Remove terminal control bytes while preserving tabs and newlines.
  out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();

  return out.length > LINE_LIMIT ? `${out.slice(0, LINE_LIMIT)}…` : out;
}

/** Test hook: installer scripts from a loopback server (never another host). */
function scriptUrl(url: string, name: string, env: Readonly<Record<string, string | undefined>>): URL {
  const override = env["CANOPY_CLI_INSTALLER_BASE_URL"];

  if (override) {
    const base = new URL(override);

    if (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
      return new URL(`${base.href.replace(/\/$/, "")}/${name}/install.sh`);
  }

  return new URL(url);
}

async function downloadScript(url: URL, dir: string): Promise<string> {
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

  if (url.protocol !== "https:" && !loopback) throw new Error("installer scripts are only downloaded over HTTPS");
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });

  if (!response.ok) throw new Error(`could not download the installer (${response.status})`);

  if (!loopback && new URL(response.url).protocol !== "https:")
    throw new Error("the installer redirected away from HTTPS");
  const body = new Uint8Array(await response.arrayBuffer());

  if (body.byteLength === 0 || body.byteLength > SCRIPT_LIMIT)
    throw new Error("the installer script has an unexpected size");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "install.sh");
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);

  return file;
}

async function pump(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";

  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let at: number;

    while ((at = rest.indexOf("\n")) >= 0) {
      line(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
  }

  if (rest) line(rest);
}

/** Runs an argv with a time limit; resolves with the exit code (null = killed by the limit). */
async function run(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  line: (text: string) => void,
): Promise<number | null> {
  return processGovernor.run({ kind: "install" }, async () => {
    processGovernor.invalidate();

    const child = Bun.spawn([...argv], {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid);
    }, timeoutMs);

    try {
      await Promise.all([pump(child.stdout, line), pump(child.stderr, line)]);
      const code = await child.exited;

      return timedOut ? null : code;
    } finally {
      clearTimeout(timer);
      processGovernor.invalidate();
    }
  });
}

export async function runInstall(input: InstallInput): Promise<InstallOutcome> {
  const { before, target, tools } = input;
  const { env, secrets } = installEnv(input.env ?? process.env);

  const rediscover = () => {
    processGovernor.invalidate();

    return input.rediscover();
  };

  const emit = (text: string) => {
    const line = redactLine(text, secrets);

    if (line) input.onLines([line]);
  };

  // A native launcher is a symlink to one version: remember it to put it back.
  let launcher: string | undefined;

  try {
    if (before.path && lstatSync(before.path).isSymbolicLink()) launcher = readlinkSync(before.path);
  } catch {
    launcher = undefined;
  }

  const scriptDir = join(input.workDir, Bun.randomUUIDv7());

  const execute = async (recipe: Recipe, timeoutMs: number): Promise<string | undefined> => {
    let argv: readonly string[];

    if (recipe.kind === "script") {
      const url = scriptUrl(recipe.url, before.spec.name, input.env ?? process.env);
      emit(`Downloading the official installer from ${url.origin}`);
      argv = ["bash", await downloadScript(url, scriptDir), ...recipe.args];
    } else argv = recipe.argv;
    emit(`$ ${argv.map((a, i) => (i === 1 && recipe.kind === "script" ? "install.sh" : a)).join(" ")}`);
    const code = await run(argv, tools.home, env, timeoutMs, emit);

    if (code === null) return `the installer did not finish within ${Math.round(timeoutMs / 60_000)} minutes`;

    if (code !== 0) return `the installer exited with code ${code}`;

    return undefined;
  };

  let failure: string | undefined;

  try {
    failure = await execute(input.recipe, input.timeoutMs ?? INSTALL_TIMEOUT_MS);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }

  let after = await rediscover();

  if (!failure) {
    if (!after.path) failure = `${before.spec.label} was not found after the install`;
    else if (!after.version) failure = `${after.path} does not run (--version failed)`;
    else if (target !== "latest" && after.version !== target) failure = `expected ${target}, found ${after.version}`;
  }

  if (!failure) {
    emit(`${before.spec.label} ${after.version} is ready`);

    return { ok: true, after };
  }

  emit(`Failed: ${failure}`);

  if (!before.version) return { ok: false, error: redactLine(failure, secrets), after };

  // Put the previous version back if it no longer answers.
  if (after.version === before.version && after.path === before.path)
    return { ok: false, error: `${redactLine(failure, secrets)}; ${before.version} is still in use`, after };

  if (launcher && before.path) {
    try {
      const temp = `${before.path}.canopy-${process.pid}`;
      rmSync(temp, { force: true });
      symlinkSync(launcher, temp);
      renameSync(temp, before.path);
      emit(`Restored ${before.path} → ${launcher}`);
    } catch (error) {
      emit(`Could not restore the launcher: ${error instanceof Error ? error.message : String(error)}`);
    }

    after = await rediscover();
  }

  if (
    after.version !== before.version &&
    [CliInstallMethod.NPM, CliInstallMethod.BUN, CliInstallMethod.VOLTA, CliInstallMethod.PNPM].includes(before.method)
  ) {
    try {
      const plan = planRecipe(before, before.version, tools);

      if (plan.recipe) {
        emit(`Reinstalling ${before.version}`);
        await execute(plan.recipe, ROLLBACK_TIMEOUT_MS);
      }
    } catch (error) {
      emit(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    after = await rediscover();
  }

  const kept = after.version === before.version && existsSync(after.path);

  return {
    ok: false,
    error: `${redactLine(failure, secrets)}; ${kept ? `${before.version} is still in use` : "the previous version could not be restored"}`,
    after,
  };
}
