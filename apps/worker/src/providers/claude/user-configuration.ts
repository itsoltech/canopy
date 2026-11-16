import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import { ProviderConfigurationMode } from "@canopy/contracts";
import { ENVIRONMENT_FILE_BYTES, readEnvironmentBlock } from "@canopy/domain/agent-environment";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeInstanceRuntime } from "./thread-types.ts";
import { readClaudeConfigurationFile } from "./user-configuration-files.ts";
import { readClaudeUserHooks } from "./user-configuration-hooks.ts";
import { claudeUserSkillSnapshots } from "./user-configuration-skills.ts";
import { readClaudePreferences } from "./user-preferences.ts";

export { CLAUDE_USER_PLUGIN_NAME } from "./user-configuration-skills.ts";

export interface ClaudeUserConfiguration {
  readonly settings: Settings;
  readonly plugins: NonNullable<Options["plugins"]>;
  readonly instructions: string;
  /** Pass this file path to Options.settings: opted-in hook definitions must never enter argv. */
  settingsFile(combined: Settings): Promise<string>;
  close(): Promise<void>;
}

/** Per-query artifacts are private and disposable; the selected source home is only ever read. */
export async function prepareClaudeUserConfiguration(
  runtime: ClaudeInstanceRuntime,
  cwd: string,
): Promise<ClaudeUserConfiguration> {
  let directory: string | undefined;
  let closed = false;
  let sequence = 0;

  const privateDirectory = () => {
    if (closed) throw new Error("The Claude user configuration has already closed.");

    if (!directory) {
      directory = mkdtempSync(join(tmpdir(), "canopy-claude-user-"));
      chmodSync(directory, 0o700);
    }

    return directory;
  };

  const close = async () => {
    closed = true;

    if (directory) await rm(directory, { recursive: true, force: true });
  };

  const configuration: ClaudeUserConfiguration = {
    settings: {},
    plugins: [],
    instructions: "",
    settingsFile: async (combined) => {
      const path = join(privateDirectory(), `settings-${sequence++}.json`);

      writeFileSync(path, JSON.stringify(combined), { mode: 0o600, flag: "wx" });

      return path;
    },
    close,
  };

  const policy = runtime.userConfiguration;

  if (policy?.mode !== ProviderConfigurationMode.LOCAL && policy?.mode !== ProviderConfigurationMode.SHARED)
    return configuration;
  const source = runtime.sourceHome;

  if (!source) throw new Error("The selected Claude configuration directory is unavailable.");

  try {
    const settings = await readClaudePreferences(source, cwd);

    const hooks = policy.hooks ? readClaudeUserHooks(source) : undefined;

    if (hooks) settings.hooks = hooks;
    const instructions = policy.instructions ? selectedInstructions(source) : "";
    const plugins = policy.skills ? claudeUserSkillSnapshots(source, privateDirectory) : [];

    return { ...configuration, settings, plugins, instructions };
  } catch (error) {
    await close();
    throw error;
  }
}

function selectedInstructions(source: string): string {
  try {
    const text = readClaudeConfigurationFile(join(source, "CLAUDE.md"), ENVIRONMENT_FILE_BYTES) ?? "";
    const managed = readEnvironmentBlock(text);

    return managed ? `${managed.before}${managed.after}`.trim() : text;
  } catch {
    throw new Error("Invalid Claude user instructions. Check the selected CLAUDE.md file.");
  }
}
