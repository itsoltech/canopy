import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { CliInstallMethod, Provider } from "@canopy/contracts";
import { ProcessTimeoutError, processKey, runProcess } from "@canopy/process-governor";
import { locate, type Location } from "./locations.ts";
import { classify, readHead, type ClassifyContext } from "./managers.ts";
import type { Env } from "./shell-env.ts";

/**
 * Provider CLIs on the device (docs/provider-cli.md). Canopy never bundles them: the worker finds the executable it
 * would run, asks its version and tells how it was installed, so the gateway can offer an install or an update that
 * the worker then runs with a fixed recipe (recipes.ts). Every copy on PATH and in the package managers' places is
 * considered; the first one that answers `--version` is used. Classification reads paths and shims only; it never
 * runs a package manager except `mise which` for a mise shim.
 */

export type CliName = "claude" | "codex" | "grok";

export interface CliSpec {
  readonly name: CliName;
  readonly provider: Provider;
  readonly label: string;
  /** The npm package (also what Bun and mise's npm backend install). */
  readonly npm: string;
  /** The official user-level installer script (POSIX), when the CLI has one. */
  readonly script?: string;
}

export const CLIS: readonly CliSpec[] = [
  {
    name: "claude",
    provider: Provider.CLAUDE,
    label: "Claude Code",
    npm: "@anthropic-ai/claude-code",
    script: "https://claude.ai/install.sh",
  },
  { name: "codex", provider: Provider.CODEX, label: "Codex", npm: "@openai/codex" },
  {
    name: "grok",
    provider: Provider.GROK,
    label: "Grok",
    npm: "@xai-official/grok",
    script: "https://x.ai/cli/install.sh",
  },
];

export const cliOf = (provider: Provider): CliSpec | undefined => CLIS.find((c) => c.provider === provider);

export type VersionProbe = { readonly line: string } | { readonly error: string };

/** What the classification needs from the device; injectable for tests. */
export interface CliProbe {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The worker runs in a container (CANOPY_INSTALL_KIND=docker, /.dockerenv, …). */
  readonly docker: boolean;
  /** The environment package-manager variables are read from (BUN_INSTALL, VOLTA_HOME, PNPM_HOME, …). */
  readonly env?: Env;
  /** Files named like the command, in search order: PATH first, then the package managers' places. */
  locate(command: string): readonly Location[];
  /** One executable by name (npm, bun, volta, pnpm for the recipes). */
  which(command: string): string | null;
  realpath(path: string): string | undefined;
  /** First line of `<executable> --version`, or why it did not run. */
  version(executable: string): Promise<VersionProbe>;
  /** The first bytes of a file, to read script shims. */
  head?(path: string): string | undefined;
  /** The tool behind a mise shim (`mise which <command>`), undefined when unknown. */
  miseWhich?(command: string): Promise<string | undefined>;
  /** The executable discovery chose (the worker runs this one too). */
  chose?(command: string, path: string): void;
}

export interface CliAlternative {
  readonly path: string;
  readonly resolvedPath: string;
  readonly method: CliInstallMethod;
  readonly version: string;
  readonly problem: string;
}

export interface DiscoveredCli {
  readonly spec: CliSpec;
  readonly method: CliInstallMethod;
  /** The executable the worker would run ("" = not found). */
  readonly path: string;
  readonly resolvedPath: string;
  readonly version: string;
  readonly configuredPath: boolean;
  /** NPM: the global prefix the package lives under; MISE/ASDF/HOMEBREW: the tool name there. */
  readonly owner?: string;
  readonly detail?: string;
  /** Why `<executable> --version` failed for the chosen executable (its first error line, a timeout). */
  readonly versionError?: string;
  /** Other copies found, not used. */
  readonly alternatives?: readonly CliAlternative[];
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
export const parseVersion = (line: string | undefined): string => line?.match(VERSION)?.[0] ?? "";

const lastChosen = new Map<string, string>();

/** The executable discovery chose for a command (worker env only), else PATH, else the package managers' places. */
export function findCli(
  command: string,
  home = homedir(),
  platform = process.platform,
  which?: (c: string) => string | null,
  env: Env = process.env,
): string | null {
  // A caller with its own environment (an instance's PATH and HOME) looks it up there, not in the worker's choice.
  const chosen = env === process.env && home === homedir() ? lastChosen.get(command) : undefined;

  if (chosen && existsSync(chosen)) return chosen;
  const onPath = which ? which(command) : Bun.which(command, { PATH: env["PATH"] ?? "" });

  return onPath ?? locate({ platform, home, env }, command).find((l) => !l.broken)?.path ?? null;
}

const MISSING = "points to a missing file";

const classifyContext = (probe: CliProbe): ClassifyContext => ({
  home: probe.home,
  ...(probe.env && { env: probe.env }),
  ...(probe.head && { head: (path: string) => probe.head?.(path) }),
});

/** The first copy that answers `--version` (in search order), else the first that exists. */
async function choose(locations: readonly Location[], probe: CliProbe) {
  const probed = new Map<string, VersionProbe>();
  const runnable = locations.filter((l) => !l.broken);

  for (const location of runnable) {
    const result = await probe.version(location.path);
    probed.set(location.path, result);

    if ("line" in result) return { chosen: location, probed };
  }

  return { chosen: runnable[0], probed };
}

function alternativesOf(
  spec: CliSpec,
  locations: readonly Location[],
  chosen: { path: string; resolvedPath: string } | undefined,
  probed: ReadonlyMap<string, VersionProbe>,
  probe: CliProbe,
): CliAlternative[] {
  const seen = new Set(chosen ? [chosen.resolvedPath || chosen.path] : []);
  const out: CliAlternative[] = [];

  for (const location of locations) {
    if (location.path === chosen?.path) continue;
    const resolvedPath = location.broken ? "" : (probe.realpath(location.path) ?? "");

    if (seen.has(resolvedPath || location.path)) continue;
    seen.add(resolvedPath || location.path);
    const result = probed.get(location.path);

    out.push({
      path: location.path,
      resolvedPath,
      method: resolvedPath
        ? classify(spec, location.path, resolvedPath, classifyContext(probe)).method
        : CliInstallMethod.OTHER,
      version: result && "line" in result ? parseVersion(result.line) : "",
      problem: location.broken ? MISSING : result && "error" in result ? result.error : "",
    });
  }

  return out;
}

/** One CLI as the worker would run it: the configured executable, else the first working copy found. */
export async function discoverCli(
  spec: CliSpec,
  configured: string | undefined,
  probe: CliProbe,
): Promise<DiscoveredCli> {
  const base = { spec, configuredPath: Boolean(configured) };
  const locations = configured ? [{ path: configured, broken: false }] : probe.locate(spec.name);
  const { chosen, probed } = await choose(locations, probe);

  if (!chosen) {
    const broken = locations.find((l) => l.broken);
    const alternatives = alternativesOf(spec, locations, undefined, probed, probe);

    return {
      ...base,
      method: probe.docker ? CliInstallMethod.DOCKER : CliInstallMethod.NOT_INSTALLED,
      path: "",
      resolvedPath: "",
      version: "",
      ...(broken && { detail: `${broken.path} ${MISSING}` }),
      ...(alternatives.length > 0 && { alternatives }),
    };
  }

  const { path } = chosen;

  if (!configured) probe.chose?.(spec.name, path);
  const resolvedPath = probe.realpath(path) ?? "";
  const result = probed.get(path);
  const version = result && "line" in result ? parseVersion(result.line) : "";
  const alternatives = alternativesOf(spec, locations, { path, resolvedPath }, probed, probe);

  const found = {
    ...base,
    path,
    resolvedPath,
    version,
    ...(!resolvedPath && { detail: `${path} does not exist` }),
    ...(resolvedPath && result && "error" in result && { versionError: result.error }),
    ...(alternatives.length > 0 && { alternatives }),
  };

  if (probe.docker) return { ...found, method: CliInstallMethod.DOCKER };

  if (!resolvedPath) return { ...found, method: CliInstallMethod.OTHER };
  let { method, owner } = classify(spec, path, resolvedPath, classifyContext(probe));

  // A shim hides the tool: ask mise which install it runs (a fixed argv, no shell).
  if (method === CliInstallMethod.MISE && !owner && probe.miseWhich) {
    const target = await probe.miseWhich(spec.name);

    if (target) owner = classify(spec, target, target, classifyContext(probe)).owner;
  }

  return { ...found, method, ...(owner && { owner }) };
}

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

// oxlint-disable-next-line no-control-regex -- Strip ANSI CSI sequences from a CLI's error output.
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(0, 300);

/** `<argv> --version`-style probe through the governor (≤2 at once, cached 60 s). */
export async function probeLine(argv: readonly string[], env: Env): Promise<VersionProbe> {
  const command = {
    argv,
    timeoutMs: VERSION_TIMEOUT_MS,
    maxBytes: VERSION_OUTPUT_LIMIT,
    env: { ...env, NO_COLOR: "1" },
  };

  try {
    const result = await runProcess(command, { kind: "probe", key: processKey(command), ttlMs: 60_000 });

    if (result.code === 0) return { line: firstLine(result.stdout) };

    return { error: plain(firstLine(result.stderr) || firstLine(result.stdout) || `exited with code ${result.code}`) };
  } catch (error) {
    return {
      error:
        error instanceof ProcessTimeoutError
          ? `no answer within ${VERSION_TIMEOUT_MS / 1000} s`
          : "the file could not be started",
    };
  }
}

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

export interface DeviceCliOptions {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly docker: boolean;
  /** Read on every call: the login-shell env (shell-env.ts) is merged into process.env once it is known. */
  env(): Env;
}

/** The device as the worker sees it: files, real paths and `--version` through the governor. */
export function deviceCliProbe(options: DeviceCliOptions): CliProbe {
  const ctx = () => ({ platform: options.platform, home: options.home, env: options.env() });

  const which = (command: string) => {
    const onPath = Bun.which(command, { PATH: options.env()["PATH"] ?? "" });

    return onPath ?? locate(ctx(), command).find((l) => !l.broken)?.path ?? null;
  };

  return {
    platform: options.platform,
    // Real path: installs are classified by real paths (/tmp or a home behind a symlink).
    home: realpath(options.home) ?? options.home,
    docker: options.docker,
    get env() {
      return options.env();
    },
    locate: (command) => locate(ctx(), command),
    which,
    realpath,
    head: readHead,
    version: (executable) => probeLine([executable, "--version"], options.env()),
    miseWhich: async (command) => {
      const mise = which("mise");
      const result = mise ? await probeLine([mise, "which", command], options.env()) : undefined;

      return result && "line" in result && result.line ? result.line : undefined;
    },
  };
}

/** This worker's device; the copies it chooses are what findCli returns to the harnesses. */
export const systemCliProbe = (docker: boolean): CliProbe => ({
  ...deviceCliProbe({ platform: process.platform, home: homedir(), docker, env: () => process.env }),
  get env() {
    return process.env;
  },
  chose: (command, path) => lastChosen.set(command, path),
});
