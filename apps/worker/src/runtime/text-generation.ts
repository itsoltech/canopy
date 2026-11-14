import { join } from "node:path";
import { Provider, type Command } from "@canopy/contracts";
import { Match } from "effect";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { generateGrokText } from "../providers/grok/generate-text.ts";
import { generateClaudeText, generateCodexText } from "../providers/generate-text.ts";
import { claudeProfileOptions } from "../providers/claude/profile.ts";
import { prepareClaudeHome } from "../providers/claude/home.ts";

import { CommandError, usableBy, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class TextGeneration {
  constructor(readonly ctx: HostContext) {}
  async generateText(
    kind: Extract<Command["kind"], { case: "generateText" }>,
    config: AppliedConfig,
  ): Promise<CommandOutput> {
    if (this.ctx.state.closing) throw new CommandError("SHUTTING_DOWN", "worker is shutting down", false);

    if (this.ctx.state.generations.size >= 4) throw new CommandError("BUSY", "text generation capacity reached", false);
    const input = kind.value;

    if (!input.prompt || input.prompt.length > 20_000)
      throw new CommandError("INVALID_PROMPT", "prompt must contain 1–20000 characters", true);

    const provider =
      input.provider === Provider.CLAUDE
        ? "claude"
        : input.provider === Provider.CODEX
          ? "codex"
          : input.provider === Provider.GROK
            ? "grok"
            : undefined;

    const profile = config.profiles.find(
      (p) => p.resolved?.id === (input.profileId || "native") && provider && usableBy(p.resolved, provider),
    )?.resolved;

    if (!provider || !profile || !usableBy(profile, provider) || !config[provider].enabled)
      throw new CommandError("PROVIDER_UNAVAILABLE", "text generation instance is unavailable", false);
    const abort = new AbortController();
    const completed = Promise.withResolvers<void>();
    this.ctx.state.generations.set(abort, completed.promise);
    const timer = setTimeout(() => abort.abort(), 30_000);

    try {
      const runtime = profile.runtime ?? {};

      const sourceHome =
        instanceShadowHome(this.ctx.state.options.dataDir, provider, profile.id, runtime) ??
        join(this.ctx.state.options.dataDir, `${provider}-home`);

      const executable = runtime.executablePath || config[provider].executable;

      const claudeHome =
        provider === "claude"
          ? prepareClaudeHome({
              dataDir: this.ctx.state.options.dataDir,
              path: sourceHome,
              ownLogin: runtime.ownLogin ?? false,
              linkDeviceLogin: config.claude.linkDeviceLogin,
              deviceClaudeHome: runtime.homePath || this.ctx.state.deviceHomes.claude,
              ...(!runtime.homePath && { deviceSecureStorage: this.ctx.state.deviceHomes.claudeSecureStorage }),
            })
          : undefined;

      const catalog = this.ctx.state.catalog?.profiles.find(
        (p) => p.provider === input.provider && p.profileId === (input.profileId || "native"),
      );

      const model = input.model || catalog?.models?.find((m) => m.isDefault)?.id || "";
      const usageKey = `${input.provider}/${profile.id}`;

      const chosen = {
        ...input,
        model,
        onUsage: this.ctx.state.usageObservers.get(usageKey)?.report,
        usageSnapshot: this.ctx.state.usage.get(usageKey)?.snapshot,
      };

      const text = await Match.value(provider).pipe(
        Match.when("grok", () =>
          generateGrokText(
            chosen,
            {
              profile,
              executable,
              dataDir: this.ctx.state.options.dataDir,
              linkDeviceLogin: config.grok.linkDeviceLogin,
            },
            abort.signal,
          ),
        ),
        Match.when("claude", () =>
          generateClaudeText(
            chosen,
            {
              cwd: sourceHome,
              ...claudeProfileOptions(profile, {
                ...process.env,
                CLAUDE_CONFIG_DIR: sourceHome,
                CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeHome?.secureStorageDir ?? sourceHome,
              }),
              ...(executable && { pathToClaudeCodeExecutable: executable }),
            },
            abort.signal,
          ),
        ),
        Match.orElse(() =>
          generateCodexText(
            chosen,
            {
              dataDir: this.ctx.state.options.dataDir,
              profile,
              clientVersion: this.ctx.state.options.clientVersion,
              launch: codexAppServerLaunch(
                [profile],
                process.env,
                executable,
                undefined,
                sourceHome,
                profile.env,
                runtime.launchArgs,
              ),
            },
            abort.signal,
          ),
        ),
      );

      return { generatedText: text };
    } catch {
      // Harness errors may contain an endpoint or auth env; do not forward them to logs or the gateway.
      throw new CommandError(
        abort.signal.aborted ? "TEXT_GENERATION_CANCELLED" : "TEXT_GENERATION_FAILED",
        "text generation failed or exceeded 30 seconds",
        false,
      );
    } finally {
      clearTimeout(timer);
      this.ctx.state.generations.delete(abort);
      completed.resolve();
    }
  }
}
