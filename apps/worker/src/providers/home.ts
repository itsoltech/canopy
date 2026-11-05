import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Isolated provider homes (CODEX_HOME, CLAUDE_CONFIG_DIR) under the worker's data dir
 * (docs/codex-adapter.md, decided 2026-11-01): the device owner's configuration (providers, MCP servers,
 * plugins, hooks) does not apply to platform threads. Only the device owner's CLI login is linked in,
 * unless the configuration turns it off (workers that use CLIProxyAPI need no device login).
 */

export interface ProviderHome {
  readonly path: string;
  /**
   * "linked" (shared token refresh), "copied" (symlinks not permitted, e.g. Windows without privilege), "own" (the
   * instance's own login, kept in this home), or none.
   */
  readonly login: "linked" | "copied" | "own" | "none";
  readonly problem?: string;
}

/** Bot processes must not discover user skills through HOME or cross-provider compatibility paths. */
export function isolatedHomeEnvironment(home: string) {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
  };
}

export interface ProviderHomeOptions {
  /** Directory of the isolated home. */
  readonly path: string;
  /** Login file name inside both homes (e.g. auth.json, .credentials.json). */
  readonly loginFile: string;
  /** The device owner's home of the same CLI. */
  readonly deviceHome: string;
  readonly linkDeviceLogin: boolean;
  /** The home keeps its own login (e.g. signed in from the app): a link left from before goes, its own file stays. */
  readonly ownLogin?: boolean;
  /** Shown when the device has no login file. */
  readonly missingLogin: string;
}

export function prepareProviderHome(options: ProviderHomeOptions): ProviderHome {
  const { path } = options;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const target = join(path, options.loginFile);

  if (options.ownLogin) {
    if (isSymlink(target)) removeIfPresent(target);

    return { path, login: existsSync(target) ? "own" : "none" };
  }

  if (!options.linkDeviceLogin) {
    removeIfPresent(target);

    return { path, login: "none" };
  }

  const source = join(options.deviceHome, options.loginFile);

  if (!existsSync(source)) {
    removeIfPresent(target);

    return { path, login: "none", problem: `${options.missingLogin} (${source})` };
  }

  if (isSymlinkTo(target, source)) return { path, login: "linked" };
  removeIfPresent(target);

  try {
    symlinkSync(source, target);

    return { path, login: "linked" };
  } catch {
    copyFileSync(source, target);

    return {
      path,
      login: "copied",
      problem: "symlinks not permitted; login copied, token refresh is not shared with the device CLI",
    };
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSymlinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function removeIfPresent(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }

  rmSync(path, { force: true });
}
