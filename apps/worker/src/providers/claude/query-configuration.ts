import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Env } from "../profiles.ts";
import type { ClaudeInstanceRuntime } from "./thread-types.ts";
import { claudeInstructionSettings, managedClaudeInstructions } from "./instructions.ts";
import { prepareClaudeUserConfiguration } from "./user-configuration.ts";

/** One subprocess gets one configuration snapshot; local files are read again for the next process. */
export async function claudeQueryConfiguration(
  runtime: ClaudeInstanceRuntime,
  cwd: string,
  scratch: boolean,
  env: Env,
  launch: Options,
) {
  const user = await prepareClaudeUserConfiguration(runtime, cwd);

  try {
    const exclusions = await claudeInstructionSettings(cwd, scratch, runtime.home, env);

    const settings = await user.settingsFile({
      ...user.settings,
      ...exclusions,
      // User skill bodies must not execute inline shell substitutions before Canopy permissions run.
      disableSkillShellExecution: true,
    });

    const instructions = [user.instructions, managedClaudeInstructions(runtime.platformHome ?? runtime.home)]
      .filter(Boolean)
      .join("\n\n");

    return {
      options: { ...launch, settings, plugins: [...(launch.plugins ?? []), ...user.plugins] },
      instructions,
      close: user.close,
    };
  } catch (error) {
    await user.close();
    throw error;
  }
}
