import { homedir } from "node:os";
import { join } from "node:path";
import { prepareProviderHome, type ProviderHome } from "../home.ts";

/**
 * Isolated CLAUDE_CONFIG_DIR for platform threads, like CODEX_HOME: the device owner's settings, hooks,
 * plugins and MCP servers do not apply; only their Claude login (.credentials.json) is linked in.
 *
 * On macOS Claude Code keeps the login in the Keychain, not in a file: there the device login is not
 * linked (use a CLIProxyAPI profile or `claude setup-token`); docs/claude-adapter.md.
 */

export interface ClaudeHomeOptions {
  readonly dataDir: string;
  readonly linkDeviceLogin: boolean;
  /** Device owner's Claude config dir: $CLAUDE_CONFIG_DIR of the worker process, else ~/.claude. */
  readonly deviceClaudeHome?: string;
}

export function deviceClaudeHome(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  return env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
}

export function prepareClaudeHome(options: ClaudeHomeOptions): ProviderHome {
  return prepareProviderHome({
    path: join(options.dataDir, "claude-home"),
    loginFile: ".credentials.json",
    deviceHome: options.deviceClaudeHome ?? deviceClaudeHome(process.env),
    linkDeviceLogin: options.linkDeviceLogin,
    missingLogin: "no Claude login file on this device; run `claude login` or use a CLIProxyAPI profile",
  });
}
