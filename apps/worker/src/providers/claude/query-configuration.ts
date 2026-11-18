import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Env } from "../profiles.ts";
import type { ClaudeInstanceRuntime } from "./thread-types.ts";
import { claudeInstructionSettings, managedClaudeInstructions } from "./instructions.ts";
import type { ClaudePermissions } from "./permissions.ts";
import { claudeFastMode } from "./service-tier.ts";
import { prepareClaudeUserConfiguration } from "./user-configuration.ts";

/** One subprocess gets one configuration snapshot; local files are read again for the next process. */
export async function claudeQueryConfiguration(
  runtime: ClaudeInstanceRuntime,
  cwd: string,
  scratch: boolean,
  env: Env,
  launch: Omit<Options, "sandbox"> & Pick<ClaudePermissions["options"], "sandbox">,
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

    // Hook settings must stay out of argv. With a settings file the SDK requires sandbox settings in that file.
    const { sandbox, ...launchWithoutSandbox } = launch;
    const hasHooks = Object.hasOwn(user.settings, "hooks");
    const settings = hasHooks ? await user.settingsFile({ ...combined, ...(sandbox && { sandbox }) }) : combined;

    const instructions = [user.instructions, managedClaudeInstructions(runtime.platformHome ?? runtime.home)]
      .filter(Boolean)
      .join("\n\n");

    return {
      options: {
        ...launchWithoutSandbox,
        ...(!hasHooks && sandbox && { sandbox }),
        settings,
        plugins: [...(launch.plugins ?? []), ...user.plugins],
      },
      instructions,
      close: user.close,
    };
  } catch (error) {
    await user.close();
    throw error;
  }
}
