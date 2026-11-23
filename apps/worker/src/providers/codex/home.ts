import { homedir } from "node:os";
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { prepareProviderHome, type ProviderHome } from "../home.ts";
import { isManagedCodexLogin } from "./legacy-login.ts";

/**
 * Isolated CODEX_HOME for platform threads (docs/codex-adapter.md, decided 2026-11-01).
 *
 * Without it Codex reads the device owner's ~/.codex: their providers, MCP servers, plugins and
 * hooks would apply to platform threads. The worker keeps its own home under the data dir; only
 * the device owner's Codex login and its write lock are linked in when device login is selected.
 */

export interface CodexHomeOptions {
  readonly dataDir: string;
  /** The home itself (an instance's shadow home); default <dataDir>/codex-home. */
  readonly path?: string;
  /** The home keeps the instance's own login (no device login linked). */
  readonly ownLogin?: boolean;
  /** Link the device owner's login (auth.json). */
  readonly linkDeviceLogin: boolean;
  /** Device owner's Codex home: $CODEX_HOME of the worker process, else ~/.codex. */
  readonly deviceCodexHome?: string;
  readonly protectedDeviceHome?: string;
}

export type CodexHome = ProviderHome;

export function deviceCodexHome(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  return env["CODEX_HOME"] || join(home, ".codex");
}

export function prepareCodexHome(options: CodexHomeOptions, platform = process.platform): CodexHome {
  const path = options.path ?? join(options.dataDir, "codex-home");
  const deviceHome = options.deviceCodexHome ?? deviceCodexHome(process.env);

  const home = prepareProviderHome({
    path,
    loginFile: "auth.json",
    deviceHome,
    protectedDeviceHome: options.protectedDeviceHome ?? deviceCodexHome(process.env),
    linkDeviceLogin: options.linkDeviceLogin,
    ...(options.ownLogin && { ownLogin: true }),
    recoverLegacyLogin: () =>
      (platform === "win32" || (options.linkDeviceLogin && existsSync(join(deviceHome, "auth.json")))) &&
      isManagedCodexLogin(options.dataDir, path),
    ...(platform === "win32" && {
      linkProblem: "Canopy could not use the device login. Enable Windows Developer Mode to share it.",
    }),
    missingLogin: "no Codex login on this device; run `codex login` or use a CLIProxyAPI profile",
  });

  const lock = join(path, "auth.lock");

  if (options.ownLogin || !options.linkDeviceLogin) {
    if (lstatSync(lock, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(lock);
  } else if (home.login === "linked") {
    try {
      linkCodexWriteLock(path, deviceHome);
    } catch {
      return {
        path,
        login: "none",
        linkFailed: true,
        problem: "Could not share the Codex login lock. Check the instance home and its permissions.",
      };
    }
  }

  return home;
}

/** Codex 0.171 opens auth.lock relative to its home. Its second lock, auth.json.lock, already follows auth.json. */
function linkCodexWriteLock(path: string, deviceHome: string): void {
  const lock = join(path, "auth.lock");
  const source = resolve(deviceHome, "auth.lock");
  const current = lstatSync(lock, { throwIfNoEntry: false });

  if (current?.isSymbolicLink() && relative(resolve(path, readlinkSync(lock)), source) === "") return;

  if (current && !(current.isSymbolicLink() || (current.isFile() && current.size === 0)))
    throw new Error("Unexpected Codex lock file");

  // Stage before replacing an older private lock. Codex creates the source lock on first use.
  const staged = `${lock}.canopy-${Bun.randomUUIDv7()}`;
  symlinkSync(source, staged, "file");

  try {
    renameSync(staged, lock);
  } catch (error) {
    unlinkSync(staged);
    throw error;
  }
}
