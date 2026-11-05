import { closeSync, openSync, readSync } from "node:fs";
import { basename, dirname } from "node:path";
import { CliInstallMethod } from "@canopy/contracts";
import type { Env } from "./shell-env.ts";

/**
 * Which package manager owns an executable (docs/provider-cli.md, "Sposób instalacji"). Decided by the real path
 * after symlinks, the shim the path points to, and for script shims (pnpm, npm on some prefixes) the package path
 * written inside the shim. A path prefix alone never decides: npm installs into Homebrew's prefix too.
 */

export interface ManagedSpec {
  readonly name: string;
  /** The npm package (also what Bun, Volta, pnpm, Yarn and mise's npm backend install). */
  readonly npm: string;
}

export interface ClassifyContext {
  readonly home: string;
  readonly env?: Env;
  /** The first bytes of a file (script shims); undefined when unreadable. */
  readonly head?: (path: string) => string | undefined;
}

export interface CliClassification {
  readonly method: CliInstallMethod;
  /** NPM: the global prefix the package lives under; MISE/ASDF/HOMEBREW: the tool name there. */
  readonly owner?: string;
}

const slashes = (path: string) => path.replaceAll("\\", "/");
const trim = (path: string | undefined) => (path ? slashes(path).replace(/\/$/, "") : undefined);

/** The first 4 KiB of a file: enough for a shebang and a package manager's shim. */
export function readHead(path: string): string | undefined {
  let fd: number | undefined;

  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");

    // Binaries are not shims.
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function versionManager(both: readonly string[]): CliClassification | undefined {
  const mise = both.map((x) => x.match(/\/mise\/installs\/([^/]+)\//)?.[1]).find(Boolean);

  if (mise || both.some((x) => x.includes("/mise/shims/")))
    return { method: CliInstallMethod.MISE, ...(mise && { owner: mise }) };
  const asdf = both.map((x) => x.match(/\/\.asdf\/installs\/([^/]+)\//)?.[1]).find(Boolean);

  if (asdf || both.some((x) => x.includes("/.asdf/shims/")))
    return { method: CliInstallMethod.ASDF, ...(asdf && { owner: asdf }) };

  return undefined;
}

function nodePackageManager(spec: ManagedSpec, r: string, ctx: ClassifyContext): CliClassification | undefined {
  const volta = trim(ctx.env?.["VOLTA_HOME"]);
  const bun = trim(ctx.env?.["BUN_INSTALL"]);

  if (
    /^volta-shim(\.exe)?$/.test(basename(r)) ||
    r.includes("/.volta/tools/image/") ||
    (volta && r.startsWith(`${volta}/tools/image/`))
  )
    return { method: CliInstallMethod.VOLTA };

  if (r.includes("/.bun/install/global/") || (bun && r.startsWith(`${bun}/install/global/`)))
    return { method: CliInstallMethod.BUN };

  if (r.includes("/pnpm/global/") || r.includes("/.pnpm/")) return { method: CliInstallMethod.PNPM };

  if (r.includes("/yarn/global/node_modules/") || r.includes("/.yarn/global/"))
    return { method: CliInstallMethod.YARN };
  const marker = `/node_modules/${spec.npm}/`;
  const at = r.indexOf(marker);

  if (at > 0) {
    // POSIX: <prefix>/lib/node_modules/<pkg>; Windows: <prefix>/node_modules/<pkg>.
    const root = r.slice(0, at);

    return { method: CliInstallMethod.NPM, owner: root.endsWith("/lib") ? root.slice(0, -4) : root };
  }

  return undefined;
}

/** A script shim names the package it runs (pnpm writes `$basedir/global/5/node_modules/<pkg>/…`). */
function shim(spec: ManagedSpec, path: string, r: string, ctx: ClassifyContext): CliClassification | undefined {
  const text = ctx.head?.(r);

  if (!text?.startsWith("#!") || !text.includes(`node_modules/${spec.npm}/`)) return undefined;
  const pnpm = trim(ctx.env?.["PNPM_HOME"]);

  if (text.includes("/pnpm/global/") || text.includes("/global/5/") || (pnpm && dirname(slashes(path)) === pnpm))
    return { method: CliInstallMethod.PNPM };

  if (text.includes(".bun/install/global/")) return { method: CliInstallMethod.BUN };

  return undefined;
}

/**
 * The install method of an executable from its path and real path. Version managers and Homebrew's own installs
 * win over npm (mise's npm backend and Homebrew formulae keep node_modules too); a package under Homebrew's prefix
 * that Homebrew did not install (`npm i -g` with Homebrew's node) is npm's.
 */
export function classify(spec: ManagedSpec, path: string, resolvedPath: string, ctx: ClassifyContext) {
  const p = slashes(path);
  const r = slashes(resolvedPath);
  const h = trim(ctx.home) ?? "";
  const managed = versionManager([p, r]);

  if (managed) return managed;
  const cask = r.match(/\/Caskroom\/([^/]+)\//)?.[1];

  if (cask) return { method: CliInstallMethod.HOMEBREW, owner: `--cask ${cask}` };
  const formula = r.match(/\/Cellar\/([^/]+)\//)?.[1];

  if (formula) return { method: CliInstallMethod.HOMEBREW, owner: formula };

  if (spec.name === "claude" && r.startsWith(`${h}/.local/share/claude/versions/`))
    return { method: CliInstallMethod.NATIVE };

  if (spec.name === "grok" && (r.startsWith(`${h}/.grok/bin/`) || r.startsWith(`${h}/.grok/downloads/`)))
    return { method: CliInstallMethod.NATIVE };
  const node = nodePackageManager(spec, r, ctx) ?? shim(spec, p, r, ctx);

  if (node) return node;

  if (/^(\/opt\/homebrew|\/home\/linuxbrew\/\.linuxbrew|\/usr\/local\/Homebrew)\//.test(r))
    return { method: CliInstallMethod.HOMEBREW };

  return { method: CliInstallMethod.OTHER };
}
