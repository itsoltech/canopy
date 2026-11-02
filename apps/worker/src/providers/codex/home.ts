import { homedir } from "node:os";
import { join } from "node:path";
import { prepareProviderHome, type ProviderHome } from "../home.ts";

/**
 * Isolated CODEX_HOME for platform threads (docs/codex-adapter.md, decided 2026-11-01).
 *
 * Without it Codex reads the device owner's ~/.codex: their providers, MCP servers, plugins and
 * hooks would apply to platform threads. The worker keeps its own home under the data dir; only
 * the device owner's Codex login (auth.json) is linked in, unless the configuration turns it off.
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
}

export type CodexHome = ProviderHome;

export function deviceCodexHome(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  return env["CODEX_HOME"] || join(home, ".codex");
}

export function prepareCodexHome(options: CodexHomeOptions): CodexHome {
  return prepareProviderHome({
    path: options.path ?? join(options.dataDir, "codex-home"),
    loginFile: "auth.json",
    deviceHome: options.deviceCodexHome ?? deviceCodexHome(process.env),
    linkDeviceLogin: options.linkDeviceLogin,
    ...(options.ownLogin && { ownLogin: true }),
    missingLogin: "no Codex login on this device; run `codex login` or use a CLIProxyAPI profile",
  });
}
