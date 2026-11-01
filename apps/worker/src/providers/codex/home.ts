import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Isolated CODEX_HOME for platform threads (docs/codex-adapter.md, decided 2026-11-01).
 *
 * Without it Codex reads the device owner's ~/.codex: their providers, MCP servers, plugins and
 * hooks would apply to platform threads. The worker keeps its own home under the data dir; only
 * the device owner's Codex login (auth.json) is linked in, unless the configuration turns it off
 * (workers that use CLIProxyAPI need no device login).
 */

export interface CodexHomeOptions {
  readonly dataDir: string;
  /** Link the device owner's login (auth.json). */
  readonly linkDeviceLogin: boolean;
  /** Device owner's Codex home: $CODEX_HOME of the worker process, else ~/.codex. */
  readonly deviceCodexHome?: string;
}

export interface CodexHome {
  readonly path: string;
  /** "linked" (shared token refresh), "copied" (symlinks not permitted, e.g. Windows without privilege), or absent. */
  readonly login: "linked" | "copied" | "none";
  readonly problem?: string;
}

export function deviceCodexHome(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  return env["CODEX_HOME"] || join(home, ".codex");
}

export function prepareCodexHome(options: CodexHomeOptions): CodexHome {
  const path = join(options.dataDir, "codex-home");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const target = join(path, "auth.json");

  if (!options.linkDeviceLogin) {
    removeIfPresent(target);
    return { path, login: "none" };
  }
  const source = join(options.deviceCodexHome ?? deviceCodexHome(process.env), "auth.json");
  if (!existsSync(source)) {
    removeIfPresent(target);
    return { path, login: "none", problem: `no Codex login on this device (${source}); run \`codex login\` or use a CLIProxyAPI profile` };
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
