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
  /** "linked" (shared token refresh), "copied" (symlinks not permitted, e.g. Windows without privilege), or none. */
  readonly login: "linked" | "copied" | "none";
  readonly problem?: string;
}

export interface ProviderHomeOptions {
  /** Directory of the isolated home. */
  readonly path: string;
  /** Login file name inside both homes (e.g. auth.json, .credentials.json). */
  readonly loginFile: string;
  /** The device owner's home of the same CLI. */
  readonly deviceHome: string;
  readonly linkDeviceLogin: boolean;
  /** Shown when the device has no login file. */
  readonly missingLogin: string;
}

export function prepareProviderHome(options: ProviderHomeOptions): ProviderHome {
  const { path } = options;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const target = join(path, options.loginFile);

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
    return { path, login: "copied", problem: "symlinks not permitted; login copied, token refresh is not shared with the device CLI" };
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
