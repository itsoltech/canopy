import { existsSync, linkSync, lstatSync, mkdirSync, readlinkSync, statSync, unlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./profiles.ts";
import { providerHomeProblem } from "./home-paths.ts";

/**
 * Isolated provider homes (CODEX_HOME, CLAUDE_CONFIG_DIR) under the worker's data dir
 * (docs/codex-adapter.md, decided 2026-11-01): the device owner's configuration (providers, MCP servers,
 * plugins, hooks) does not apply to platform threads. Only the device owner's CLI login is linked in,
 * unless the configuration turns it off (workers that use CLIProxyAPI need no device login).
 */

export interface ProviderHome {
  readonly path: string;
  /**
   * "linked" (shared token refresh), "own" (the
   * instance's own login, kept in this home), or none.
   */
  readonly login: "linked" | "own" | "none";
  readonly problem?: string;
}

/** Bots have no shell and can replace HOME to hide device compatibility paths. */
export function isolatedHomeEnvironment(home: string, device: Env = process.env, platform = process.platform) {
  return {
    ...versionManagerEnvironment(device, platform),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
  };
}

/**
 * Version managers locate their installs, settings and trust records through HOME and XDG. Their shims (the CLI
 * discovery chose, or `node` behind a CLI's launcher) must still run under a replaced home, so these keep the
 * device's directories. They hold tool versions, not provider configuration. Windows managers use LOCALAPPDATA.
 */
function versionManagerEnvironment(device: Env, platform: NodeJS.Platform) {
  if (platform === "win32") return {};
  const home = device["HOME"] || homedir();
  const config = device["XDG_CONFIG_HOME"] || join(home, ".config");
  const data = device["XDG_DATA_HOME"] || join(home, ".local", "share");
  const state = device["XDG_STATE_HOME"] || join(home, ".local", "state");

  return {
    MISE_CONFIG_DIR: device["MISE_CONFIG_DIR"] || join(config, "mise"),
    MISE_DATA_DIR: device["MISE_DATA_DIR"] || join(data, "mise"),
    MISE_STATE_DIR: device["MISE_STATE_DIR"] || join(state, "mise"),
    MISE_GLOBAL_CONFIG_ROOT: device["MISE_GLOBAL_CONFIG_ROOT"] || home,
    ASDF_DATA_DIR: device["ASDF_DATA_DIR"] || join(home, ".asdf"),
    VOLTA_HOME: device["VOLTA_HOME"] || join(home, ".volta"),
  };
}

export interface ProviderHomeOptions {
  /** Directory of the isolated home. */
  readonly path: string;
  /** Login file name inside both homes (e.g. auth.json, .credentials.json). */
  readonly loginFile: string;
  /** The device owner's home of the same CLI. */
  readonly deviceHome: string;
  /** Actual device CLI home, protected even when deviceHome selects a custom login source. */
  readonly protectedDeviceHome?: string;
  readonly linkDeviceLogin: boolean;
  /** The home keeps its own login (e.g. signed in from the app): a link left from before goes, its own file stays. */
  readonly ownLogin?: boolean;
  /** Shown when the device has no login file. */
  readonly missingLogin: string;
}

export function prepareProviderHome(options: ProviderHomeOptions): ProviderHome {
  const { path } = options;
  const problem = providerHomeProblem(path, options.deviceHome, options.protectedDeviceHome);

  if (problem) throw new Error(problem);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const target = join(path, options.loginFile);
  const source = join(options.deviceHome, options.loginFile);
  const protectedSource = join(options.protectedDeviceHome ?? options.deviceHome, options.loginFile);
  const shared = isSharedFile(target, [source, protectedSource]);

  if (options.ownLogin) {
    if (shared) removeIfPresent(target);

    return { path, login: existsSync(target) ? "own" : "none" };
  }

  // A regular login may belong to the user or an instance with its own login. Never replace it implicitly.
  if (existsSync(target) && !shared)
    throw new Error("The shadow home already contains a login. Use its own login or choose a different shadow home.");

  if (!options.linkDeviceLogin) {
    removeIfPresent(target);

    return { path, login: "none" };
  }

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
    // Pinned Codex writes auth.json in place. NTFS hard links share refresh writes without symlink privileges.
    if (process.platform === "win32") {
      try {
        linkSync(source, target);

        return { path, login: "linked" };
      } catch {
        /* Refuse stale copies. */
      }
    }

    return {
      path,
      login: "none",
      problem:
        "cannot link the device login; allow symbolic links on this computer or use an instance with its own login",
    };
  }
}

function isSharedFile(path: string, sources: readonly string[]): boolean {
  try {
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) return true;

    if (!stat.isFile() || stat.nlink < 2) return false;

    return sources.some((source) => {
      try {
        const device = statSync(source);

        return device.isFile() && device.dev === stat.dev && device.ino === stat.ino;
      } catch {
        return false;
      }
    });
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

  unlinkSync(path);
}
