import { homedir } from "node:os";
import { join } from "node:path";
import { prepareProviderHome, type ProviderHome } from "../home.ts";

/**
 * Isolated CLAUDE_CONFIG_DIR for platform threads, like CODEX_HOME: the device owner's settings, hooks,
 * plugins and MCP servers do not apply; secure storage selects the source login independently.
 *
 * CLAUDE_SECURESTORAGE_CONFIG_DIR selects the login independently, including macOS Keychain entries.
 */

export interface ClaudeHomeOptions {
  readonly dataDir: string;
  /** The home itself (an instance's shadow home); default <dataDir>/claude-home. */
  readonly path?: string;
  /** The home keeps the instance's own login (no device login linked). */
  readonly ownLogin?: boolean;
  readonly linkDeviceLogin: boolean;
  /** Device owner's Claude config dir: $CLAUDE_CONFIG_DIR of the worker process, else ~/.claude. */
  readonly deviceClaudeHome?: string;
  /** Empty selects the default, unhashed keychain service; a path selects a config-scoped service. */
  readonly deviceSecureStorage?: string;
}

export function deviceClaudeHome(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  return env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
}

export function prepareClaudeHome(options: ClaudeHomeOptions): ProviderHome & { secureStorageDir: string } {
  const path = options.path ?? join(options.dataDir, "claude-home");
  const deviceHome = options.deviceClaudeHome ?? deviceClaudeHome(process.env);

  const home = prepareProviderHome({
    path,
    loginFile: ".credentials.json",
    deviceHome,
    // Secure storage selects the actual file too, not only macOS Keychain. Never copy a refresh token.
    linkDeviceLogin: false,
    ...(options.ownLogin && { ownLogin: true }),
    missingLogin: "no Claude login file on this device; run `claude auth login` or use a CLIProxyAPI profile",
  });

  return {
    ...home,
    secureStorageDir: !options.ownLogin && options.linkDeviceLogin ? (options.deviceSecureStorage ?? deviceHome) : path,
  };
}
