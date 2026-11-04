import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliInstallMethod, Provider } from "@canopy/contracts";

/**
 * Provider CLIs on the device (docs/provider-cli.md). Canopy never bundles them: the worker finds the executable it
 * would run, asks its version and tells how it was installed, so the gateway can offer an install or an update that
 * the worker then runs with a fixed recipe (recipes.ts). Classification reads paths only; it never runs a package
 * manager except `mise which` for a mise shim.
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

/** What the classification needs from the device; injectable for tests. */
export interface CliProbe {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The worker runs in a container (CANOPY_INSTALL_KIND=docker, /.dockerenv, …). */
  readonly docker: boolean;
  which(command: string): string | null;
  realpath(path: string): string | undefined;
  /** First line of `<executable> --version`, undefined when it does not run. */
  version(executable: string): Promise<string | undefined>;
  /** The tool behind a mise shim (`mise which <command>`), undefined when unknown. */
  miseWhich?(command: string): Promise<string | undefined>;
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
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
export const parseVersion = (line: string | undefined): string => line?.match(VERSION)?.[0] ?? "";

/** User-level places the official installers and package managers put CLIs, for a worker whose PATH lacks them. */
export function knownLocations(command: string, home: string, platform: NodeJS.Platform): string[] {
  const exe = platform === "win32" ? `${command}.exe` : command;
  const places = [join(home, ".local", "bin", exe), join(home, ".bun", "bin", exe)];

  if (command === "claude") places.push(join(home, ".claude", "local", exe));

  if (command === "grok") places.push(join(home, ".grok", "bin", exe));

  return places;
}

/** PATH first, then the known user-level locations (a service manager's PATH often lacks ~/.local/bin). */
export function findCli(
  command: string,
  home = homedir(),
  platform = process.platform,
  which: (c: string) => string | null = Bun.which,
): string | null {
  return which(command) ?? knownLocations(command, home, platform).find((p) => existsSync(p)) ?? null;
}

const slashes = (path: string) => path.replaceAll("\\", "/");

/**
 * The install method of an executable from its path and real path. Version managers and Homebrew win over npm
 * (mise's npm backend keeps node_modules too); a native installer is recognised by its own versions directory.
 */
export function classify(spec: CliSpec, path: string, resolvedPath: string, home: string): CliClassification {
  const p = slashes(path);
  const r = slashes(resolvedPath);
  const h = slashes(home).replace(/\/$/, "");
  const both = [p, r];
  const mise = both.map((x) => x.match(/\/mise\/installs\/([^/]+)\//)?.[1]).find(Boolean);

  if (mise || both.some((x) => x.includes("/mise/shims/")))
    return { method: CliInstallMethod.MISE, ...(mise && { owner: mise }) };
  const asdf = both.map((x) => x.match(/\/\.asdf\/installs\/([^/]+)\//)?.[1]).find(Boolean);

  if (asdf || both.some((x) => x.includes("/.asdf/shims/")))
    return { method: CliInstallMethod.ASDF, ...(asdf && { owner: asdf }) };
  const cask = r.match(/\/Caskroom\/([^/]+)\//)?.[1];

  if (cask) return { method: CliInstallMethod.HOMEBREW, owner: `--cask ${cask}` };
  const formula = r.match(/\/Cellar\/([^/]+)\//)?.[1];

  if (formula) return { method: CliInstallMethod.HOMEBREW, owner: formula };

  if (/^(\/opt\/homebrew|\/home\/linuxbrew\/\.linuxbrew|\/usr\/local\/Homebrew)\//.test(r))
    return { method: CliInstallMethod.HOMEBREW };

  if (spec.name === "claude" && r.startsWith(`${h}/.local/share/claude/versions/`))
    return { method: CliInstallMethod.NATIVE };

  if (spec.name === "grok" && (r.startsWith(`${h}/.grok/bin/`) || r.startsWith(`${h}/.grok/downloads/`)))
    return { method: CliInstallMethod.NATIVE };

  if (r.includes("/.bun/install/global/")) return { method: CliInstallMethod.BUN };
  const marker = `/node_modules/${spec.npm}/`;
  const at = r.indexOf(marker);

  if (at > 0) {
    // POSIX: <prefix>/lib/node_modules/<pkg>; Windows: <prefix>/node_modules/<pkg>.
    const root = r.slice(0, at);

    return { method: CliInstallMethod.NPM, owner: root.endsWith("/lib") ? root.slice(0, -4) : root };
  }

  return { method: CliInstallMethod.OTHER };
}

interface CliClassification {
  readonly method: CliInstallMethod;
  readonly owner?: string;
}

/** One CLI as the worker would run it: the configured executable, else PATH and the known user-level locations. */
export async function discoverCli(
  spec: CliSpec,
  configured: string | undefined,
  probe: CliProbe,
): Promise<DiscoveredCli> {
  const path = configured || probe.which(spec.name) || "";
  const base = { spec, configuredPath: Boolean(configured) };

  if (!path || (!configured && !existsSync(path))) {
    return {
      ...base,
      method: probe.docker ? CliInstallMethod.DOCKER : CliInstallMethod.NOT_INSTALLED,
      path: "",
      resolvedPath: "",
      version: "",
    };
  }

  const resolvedPath = probe.realpath(path) ?? "";
  const version = parseVersion(await probe.version(path));
  const found = { ...base, path, resolvedPath, version, ...(!resolvedPath && { detail: `${path} does not exist` }) };

  if (probe.docker) return { ...found, method: CliInstallMethod.DOCKER };

  if (!resolvedPath) return { ...found, method: CliInstallMethod.OTHER };
  let { method, owner } = classify(spec, path, resolvedPath, probe.home);

  // A shim hides the tool: ask mise which install it runs (a fixed argv, no shell).
  if (method === CliInstallMethod.MISE && !owner && probe.miseWhich) {
    const target = await probe.miseWhich(spec.name);

    if (target) owner = classify(spec, target, target, probe.home).owner;
  }

  return { ...found, method, ...(owner && { owner }) };
}

const VERSION_TIMEOUT_MS = 10_000;

async function firstLine(argv: string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: VERSION_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: "1" },
    });

    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    return code === 0 ? out.trim().split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}

export const systemCliProbe = (docker: boolean): CliProbe => ({
  platform: process.platform,
  // Real path: installs are classified by real paths (/tmp or a home behind a symlink).
  home: (() => {
    try {
      return realpathSync(homedir());
    } catch {
      return homedir();
    }
  })(),
  docker,
  which: (command) => findCli(command),
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
  version: (executable) => firstLine([executable, "--version"]),
  miseWhich: async (command) => {
    const mise = Bun.which("mise");

    return mise ? firstLine([mise, "which", command]) : undefined;
  },
});
