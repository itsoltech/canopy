import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Env } from "../profiles.ts";
import type { ClaudeInstanceRuntime } from "./thread-types.ts";
import { claudeInstructionSettings, managedClaudeInstructions } from "./instructions.ts";
import { claudeFastMode } from "./service-tier.ts";
import { prepareClaudeUserConfiguration } from "./user-configuration.ts";

/** One subprocess gets one configuration snapshot; local files are read again for the next process. */
export async function claudeQueryConfiguration(
  runtime: ClaudeInstanceRuntime,
  cwd: string,
  scratch: boolean,
  env: Env,
  launch: Options,
  serviceTier = "default",
) {
  const user = await prepareClaudeUserConfiguration(runtime, cwd);

  try {
    const exclusions = await claudeInstructionSettings(cwd, scratch, runtime.home, env);

    const combined = {
      ...user.settings,
      ...exclusions,
      // User skill bodies must not execute inline shell substitutions before Canopy permissions run.
      disableSkillShellExecution: true,
      // Override project settings and restored transcript state on every subprocess.
      fastMode: claudeFastMode(serviceTier),
    };

    // Hook settings must stay in a private file so they never enter SDK argv. Inline settings are safe when the
    // inherited hook decoder did not contribute a hooks object, and preserve the legacy isolated startup path.
    const settings = Object.hasOwn(user.settings, "hooks") ? await user.settingsFile(combined) : combined;

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
