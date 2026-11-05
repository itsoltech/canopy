import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Env } from "./shell-env.ts";

/**
 * Where a CLI may live (docs/provider-cli.md, "Wykrywanie"): PATH (the login shell's entries first), then the
 * places package managers and official installers put executables, for a worker whose PATH lacks them. Only the
 * file system is read here; no package manager runs.
 */

export interface LocationContext {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Env;
}

/** The global prefix from npm's user config (`prefix=` in ~/.npmrc), read without running npm. */
export function npmrcPrefix(ctx: LocationContext): string | undefined {
  const file = ctx.env["NPM_CONFIG_USERCONFIG"] || ctx.env["npm_config_userconfig"] || join(ctx.home, ".npmrc");

  try {
    const line = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^prefix\s*=/.test(l));

    const value = line?.replace(/^prefix\s*=\s*/, "").replace(/^["']|["']$/g, "");

    return value ? value.replace(/^~(?=\/|$)/, ctx.home).replaceAll("${HOME}", ctx.home) : undefined;
  } catch {
    return undefined;
  }
}

/** npm's global prefixes the user configured (env, then ~/.npmrc). */
export function npmPrefixes(ctx: LocationContext): string[] {
  return [ctx.env["NPM_CONFIG_PREFIX"], ctx.env["npm_config_prefix"], npmrcPrefix(ctx)].filter((p): p is string =>
    Boolean(p),
  );
}

const numeric = (name: string) =>
  name
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);

/** nvm's installed node versions, newest first (at most three). */
function nvmBins(dir: string): string[] {
  try {
    return readdirSync(join(dir, "versions", "node"))
      .toSorted((a, b) => {
        const [x, y] = [numeric(a), numeric(b)];

        return (y[0]! - x[0]!) * 1e6 + (y[1]! - x[1]!) * 1e3 + (y[2]! - x[2]!);
      })
      .slice(0, 3)
      .map((v) => join(dir, "versions", "node", v, "bin"));
  } catch {
    return [];
  }
}

const env = (ctx: LocationContext, name: string) => ctx.env[name] || undefined;

/** Package-manager and installer bin directories, most specific first. */
export function knownDirectories(ctx: LocationContext, command: string): string[] {
  const { home, platform } = ctx;
  const data = env(ctx, "XDG_DATA_HOME") ?? join(home, ".local", "share");
  const config = env(ctx, "XDG_CONFIG_HOME") ?? join(home, ".config");
  const opt = (dir: string | undefined, ...rest: string[]) => (dir ? [join(dir, ...rest)] : []);

  if (platform === "win32") {
    return [
      ...opt(env(ctx, "APPDATA"), "npm"),
      ...opt(env(ctx, "VOLTA_HOME"), "bin"),
      ...opt(env(ctx, "LOCALAPPDATA"), "Volta", "bin"),
      join(home, "scoop", "shims"),
      ...opt(env(ctx, "BUN_INSTALL"), "bin"),
      join(home, ".bun", "bin"),
      ...opt(env(ctx, "PNPM_HOME")),
      join(home, ".local", "bin"),
    ];
  }

  return [
    join(home, ".local", "bin"),
    ...(command === "claude" ? [join(home, ".claude", "local")] : []),
    ...(command === "grok" ? [join(home, ".grok", "bin")] : []),
    ...opt(env(ctx, "BUN_INSTALL"), "bin"),
    join(home, ".bun", "bin"),
    ...opt(env(ctx, "VOLTA_HOME"), "bin"),
    join(home, ".volta", "bin"),
    ...opt(env(ctx, "PNPM_HOME")),
    ...(platform === "darwin" ? [join(home, "Library", "pnpm")] : [join(data, "pnpm")]),
    ...npmPrefixes(ctx).map((p) => join(p, "bin")),
    join(home, ".npm-global", "bin"),
    join(home, ".yarn", "bin"),
    join(config, "yarn", "global", "node_modules", ".bin"),
    ...opt(env(ctx, "NVM_BIN")),
    ...nvmBins(env(ctx, "NVM_DIR") ?? join(home, ".nvm")),
    ...opt(env(ctx, "FNM_MULTISHELL_PATH"), "bin"),
    ...opt(env(ctx, "FNM_DIR"), "aliases", "default", "bin"),
    join(data, "fnm", "aliases", "default", "bin"),
    ...(platform === "darwin"
      ? [join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")]
      : []),
    ...opt(env(ctx, "MISE_DATA_DIR"), "shims"),
    join(data, "mise", "shims"),
    ...opt(env(ctx, "ASDF_DATA_DIR"), "shims"),
    join(home, ".asdf", "shims"),
    ...opt(env(ctx, "HOMEBREW_PREFIX"), "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    join(home, ".linuxbrew", "bin"),
  ];
}

/** Every directory searched, in order: PATH, then the known ones (duplicates dropped). */
export function searchDirectories(ctx: LocationContext, command: string): string[] {
  const path = (ctx.env["PATH"] ?? ctx.env["Path"] ?? "").split(delimiter).filter(Boolean);

  return [...new Set([...path, ...knownDirectories(ctx, command)])];
}

export interface Location {
  readonly path: string;
  /** A symlink whose target is gone. */
  readonly broken: boolean;
}

const MAX_LOCATIONS = 8;

/** The files named like the command in those directories, broken symlinks included. */
export function locate(ctx: LocationContext, command: string): Location[] {
  const exe = ctx.platform === "win32" ? `${command}.exe` : command;
  const found: Location[] = [];

  for (const dir of searchDirectories(ctx, command)) {
    const path = join(dir, exe);

    try {
      const link = lstatSync(path);

      if (link.isDirectory()) continue;
      const broken = link.isSymbolicLink() && !existsSync(path);

      // A file without an execute bit is not a CLI (a stray copy, a README).
      if (!broken && ctx.platform !== "win32" && (statSync(path).mode & 0o111) === 0) continue;
      found.push({ path, broken });
    } catch {
      continue;
    }

    if (found.length >= MAX_LOCATIONS) break;
  }

  return found;
}

/**
 * PATH with a node runtime when it has none: JS shims (`#!/usr/bin/env node`) from npm, Bun, pnpm or Yarn need one,
 * and a GUI or service PATH often lacks Volta's, nvm's or Homebrew's. Appended last, so the user's own node wins.
 */
export function withNodeOnPath(ctx: LocationContext): string | undefined {
  const path = ctx.env["PATH"] ?? "";
  const node = ctx.platform === "win32" ? "node.exe" : "node";
  const dirs = path.split(delimiter).filter(Boolean);

  if (dirs.some((dir) => existsSync(join(dir, node)))) return undefined;
  const found = knownDirectories(ctx, "node").find((dir) => existsSync(join(dir, node)));

  return found ? [...dirs, found].join(delimiter) : undefined;
}
