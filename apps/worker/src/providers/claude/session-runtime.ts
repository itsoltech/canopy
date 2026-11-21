import { getSessionMessages, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadSpec } from "@canopy/contracts";
import { claudeExecutable } from "./executable.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { claudeProfileOptions } from "./profile.ts";
import { claudeSkillPlugins } from "./skill-plugin.ts";
import { managedPlugins } from "../../agent-environment/plugin-loading.ts";
import { spawnClaude } from "./spawn.ts";
import { claudeSessionHomes } from "./session-home.ts";

import type { ClaudeInstanceRuntime, ClaudeThreadContext } from "./thread-types.ts";

// SDK helpers read process.env. Serialize across every instance, not just one runtime.
let helpers: Promise<unknown> = Promise.resolve();

export function claudeRuntime(ctx: ClaudeThreadContext) {
  const { options } = ctx;
  const homes = claudeSessionHomes(ctx.journal);

  /** The runtime of a profile: its own (an instance with its own config dir or executable), else the runtime's. */
  const runtimeOf = (profile: ResolvedProfile, spec?: ThreadSpec): ClaudeInstanceRuntime => ({
    ...(options.runtimeOf?.(profile, spec) ?? {
      home: options.home,
      ...(options.executable && { executable: options.executable }),
    }),
    ...(profile.runtime.claudeSettings && { settings: profile.runtime.claudeSettings }),
  });

  const queryRuntime = (
    profile: ResolvedProfile,
    runtime: ClaudeInstanceRuntime,
  ): Pick<
    Options,
    "env" | "settingSources" | "pathToClaudeCodeExecutable" | "extraArgs" | "plugins" | "spawnClaudeCodeProcess"
  > => ({
    spawnClaudeCodeProcess: spawnClaude,
    ...claudeProfileOptions(profile, { ...options.baseEnv, CLAUDE_CONFIG_DIR: runtime.home }),
    pathToClaudeCodeExecutable: claudeExecutable(runtime.executable, options.baseEnv),
    ...(runtime.extraArgs && Object.keys(runtime.extraArgs).length > 0 && { extraArgs: runtime.extraArgs }),
    plugins: [
      ...claudeSkillPlugins(runtime.platformHome ?? runtime.home),
      ...managedPlugins(runtime.platformHome ?? runtime.home, "claude"),
    ],
  });

  /**
   * A session helper in a config dir: CLAUDE_CONFIG_DIR of this process points there meanwhile. Helpers run one at a
   * time so two homes never mix (queries get their env explicitly and are not affected).
   */
  const inHome = <A>(home: string, run: () => Promise<A>): Promise<A> => {
    const next = helpers.then(async () => {
      const previous = process.env["CLAUDE_CONFIG_DIR"];
      process.env["CLAUDE_CONFIG_DIR"] = home;

      try {
        return await run();
      } finally {
        if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
        else process.env["CLAUDE_CONFIG_DIR"] = previous;
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

  const sessionRuntime = async (profile: ResolvedProfile, spec: ThreadSpec): Promise<ClaudeInstanceRuntime> => {
    const current = runtimeOf(profile, spec);
    const existing = await homes.lookup(spec.threadId);
    const legacy = current.platformHome ?? options.home;

    const legacySession =
      !existing &&
      legacy !== current.home &&
      (await sessionExists(spec.providerThreadId || spec.threadId, spec.cwd, legacy));

    const home = await homes.bind(spec.threadId, legacySession ? legacy : current.home, spec);

    return { ...current, home };
  };

  return { runtimeOf, sessionRuntime, homes, queryRuntime, inHome, sessionExists };
}
