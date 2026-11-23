import { homedir } from "node:os";
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { codexLoginProblems } from "@canopy/domain/provider-accounts";
import { defaultCodexHomeMode } from "@canopy/domain/provider-instances";
import { Predicate } from "effect";
import { ProviderConfigurationMode } from "@canopy/contracts";
import type { ProviderProfileConfig } from "../profiles.ts";
import { codexCliHomeProblem } from "../home-paths.ts";
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

/** The built-in native instance defaults to its device CLI home. Other instances opt in explicitly. */
export function directCodexHome(
  profile: Pick<ProviderProfileConfig, "id" | "kind" | "runtime">,
  linkDeviceLogin: boolean,
  deviceHome: string,
): string | undefined {
  const { runtime } = profile;

  if (profile.kind !== "native" || runtime?.ownLogin || !linkDeviceLogin) return undefined;
  const configured = runtime?.userConfiguration?.mode ?? ProviderConfigurationMode.UNSPECIFIED;
  const mode = configured === ProviderConfigurationMode.UNSPECIFIED ? defaultCodexHomeMode(profile.id) : configured;

  return mode === ProviderConfigurationMode.SHARED ? resolve(runtime?.homePath || deviceHome) : undefined;
}

/** Isolated instances prepare their login. Direct instances only validate the two roots. */
export function prepareCodexInstanceHome(
  profile: Pick<ProviderProfileConfig, "id" | "kind" | "runtime">,
  options: { dataDir: string; path: string; deviceHome: string; linkDeviceLogin: boolean },
): Omit<CodexHome, "login"> & { login: CodexHome["login"] | "cli" } {
  const { path, deviceHome, linkDeviceLogin } = options;
  const cliHome = directCodexHome(profile, linkDeviceLogin, deviceHome);

  if (cliHome) {
    const problem = codexCliHomeProblem(path, cliHome, deviceHome);

    if (problem) throw new Error(problem);

    return { path: cliHome, login: "cli" };
  }

  return prepareCodexHome({
    dataDir: options.dataDir,
    path,
    linkDeviceLogin,
    ownLogin: profile.runtime?.ownLogin ?? false,
    deviceCodexHome: profile.runtime?.homePath || deviceHome,
    protectedDeviceHome: deviceHome,
  });
}

export function prepareCodexHome(options: CodexHomeOptions, platform = process.platform): CodexHome {
  const path = options.path ?? join(options.dataDir, "codex-home");
  const deviceHome = options.deviceCodexHome ?? deviceCodexHome(process.env);

  const windowsLinkDenied = (cause: unknown) =>
    platform === "win32" && Predicate.hasProperty(cause, "code") && (cause.code === "EPERM" || cause.code === "EACCES");

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
    linkProblem: (cause) => (windowsLinkDenied(cause) ? codexLoginProblems.windows : codexLoginProblems.link),
    missingLogin: "no Codex login on this device; run `codex login` or use a CLIProxyAPI profile",
  });

  const lock = join(path, "auth.lock");

  if (options.ownLogin || !options.linkDeviceLogin) {
    if (lstatSync(lock, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(lock);
  } else if (home.login === "linked") {
    try {
      linkCodexWriteLock(path, deviceHome);
    } catch (cause) {
      const denied = windowsLinkDenied(cause) && Predicate.hasProperty(cause, "syscall") && cause.syscall === "symlink";

      return {
        path,
        login: "none",
        linkFailed: true,
        problem: denied ? codexLoginProblems.windows : codexLoginProblems.lock,
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
