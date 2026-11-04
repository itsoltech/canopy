import { getSessionMessages, type Options } from "@anthropic-ai/claude-agent-sdk";
import { claudeExecutable } from "./executable.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { claudeProfileOptions } from "./profile.ts";
import { claudeSkillPlugins } from "./skill-plugin.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";

import type { ClaudeInstanceRuntime, ClaudeThreadContext } from "./thread-types.ts";

export function claudeRuntime(ctx: ClaudeThreadContext) {
  const { options } = ctx;

  /** The runtime of a profile: its own (an instance with its own config dir or executable), else the runtime's. */
  const runtimeOf = (profile: ResolvedProfile): ClaudeInstanceRuntime =>
    options.runtimeOf?.(profile) ?? {
      home: options.home,
      ...(options.executable && { executable: options.executable }),
    };

  const queryRuntime = (
    profile: ResolvedProfile,
    runtime: ClaudeInstanceRuntime,
  ): Pick<Options, "env" | "settingSources" | "pathToClaudeCodeExecutable" | "extraArgs" | "plugins"> => ({
    ...claudeProfileOptions(profile, { ...options.baseEnv, CLAUDE_CONFIG_DIR: runtime.home }),
    pathToClaudeCodeExecutable: claudeExecutable(runtime.executable, options.baseEnv),
    ...(runtime.extraArgs && Object.keys(runtime.extraArgs).length > 0 && { extraArgs: runtime.extraArgs }),
    plugins: [...claudeSkillPlugins(runtime.home), ...managedPlugins(runtime.home, "claude")],
  });

  /**
   * A session helper in a config dir: CLAUDE_CONFIG_DIR of this process points there meanwhile. Helpers run one at a
   * time so two homes never mix (queries get their env explicitly and are not affected).
   */
  let helpers: Promise<unknown> = Promise.resolve();

  const inHome = <A>(home: string, run: () => Promise<A>): Promise<A> => {
    const next = helpers.then(async () => {
      process.env["CLAUDE_CONFIG_DIR"] = home;

      try {
        return await run();
      } finally {
        process.env["CLAUDE_CONFIG_DIR"] = options.home;
      }
    });

    helpers = next.catch(() => {});

    return next;
  };

  const sessionExists = async (sessionId: string, cwd: string, home: string) => {
    try {
      return (await inHome(home, () => getSessionMessages(sessionId, { dir: cwd }))).length > 0;
    } catch {
      return false;
    }
  };

  return { runtimeOf, queryRuntime, inHome, sessionExists };
}
