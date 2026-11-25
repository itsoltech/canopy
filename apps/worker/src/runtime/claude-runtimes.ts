import { BackgroundTaskKind, Provider, ProviderConfigurationMode } from "@canopy/contracts";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { prepareClaudeHome } from "../providers/claude/home.ts";
import type { ProviderHome } from "../providers/home.ts";
import { claudeConfigurationHomes, claudeConfigurationHomeProblem } from "../providers/claude/configuration-homes.ts";
import { claudeExtraArgs, ClaudeThreads } from "../providers/claude/threads.ts";
import { claudeConfiguredEffort, readClaudeUserSettings } from "../providers/default-effort.ts";
import { Journal } from "../journal/index.ts";
import { requireClaudeSessionHome } from "../providers/claude/session-home.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import type { AppliedConfig } from "../config/remote.ts";

import { CommandError, kindOf } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { reportsPlanUsage, usageReporter } from "./usage-limits.ts";

export class ClaudeRuntimes {
  constructor(readonly ctx: HostContext) {}
  async runClaude<A, E>(
    use: (threads: ClaudeThreads["Service"]) => Effect.Effect<A, E>,
    id = "native",
    current = false,
  ): Promise<A> {
    return this.ctx.ops.useRuntime(`claude/${id}`, current, async () => {
      const handle = this.ctx.state.claude.get(id);

      if (!handle)
        throw new CommandError(
          "PROVIDER_UNAVAILABLE",
          this.ctx.state.config?.claude.problem ?? "claude is disabled",
          false,
        );

      return this.ctx.ops.runIn(Effect.provide(ClaudeThreads.use(use), handle.context));
    });
  }

  async startClaude(
    profile: ResolvedProfile,
    key: string,
    config: AppliedConfig | undefined = this.ctx.state.config,
  ): Promise<void> {
    if (!config) return;
    const runtime = profile.runtime;

    const selected = claudeConfigurationHomes(
      this.ctx.state.options.dataDir,
      profile.id,
      runtime,
      this.ctx.state.deviceHomes.claude,
    );

    const loginSource = runtime.homePath || this.ctx.state.deviceHomes.claude;
    const problem = claudeConfigurationHomeProblem(selected, loginSource, this.ctx.state.deviceHomes.claude);

    if (problem) throw new CommandError("PROVIDER_UNAVAILABLE", problem, false);

    const retained = await this.ctx.state.options.runtime.runPromise(
      Journal.use((journal) => journal.isClaudeSessionHomeBound(selected.platformHome)),
    );

    if (retained) requireClaudeSessionHome(selected.platformHome);

    const home: ProviderHome & { readonly secureStorageDir: string } = retained
      ? {
          path: selected.platformHome,
          login: runtime.ownLogin ? "own" : config.claude.linkDeviceLogin ? "linked" : "none",
          secureStorageDir:
            !runtime.ownLogin && config.claude.linkDeviceLogin
              ? runtime.homePath
                ? loginSource
                : (this.ctx.state.deviceHomes.claudeSecureStorage ?? loginSource)
              : selected.platformHome,
        }
      : prepareClaudeHome({
          dataDir: this.ctx.state.options.dataDir,
          path: selected.platformHome,
          ...(runtime.ownLogin && { ownLogin: true }),
          linkDeviceLogin: config.claude.linkDeviceLogin,
          deviceClaudeHome: loginSource,
          protectedDeviceHome: this.ctx.state.deviceHomes.claude,
          ...(!runtime.homePath && { deviceSecureStorage: this.ctx.state.deviceHomes.claudeSecureStorage }),
        });

    if (home.problem) this.ctx.ops.log(`claude home: ${home.problem}`);
    this.ctx.state.claudeHomes.set(profile.id, selected.home);
    const executable = runtime.executablePath || config.claude.executable;

    const usage = usageReporter(
      this.ctx,
      Provider.CLAUDE,
      profile.id,
      home.path,
      key,
      reportsPlanUsage([profile], process.env),
    );

    const layer = ClaudeThreads.layer({
      onUsage: usage.report,
      home: selected.home,
      ...(executable && { executable }),
      runtimeOf: () => ({
        ...selected,
        ...(executable && { executable }),
        extraArgs: claudeExtraArgs(runtime.launchArgs ?? []),
      }),
      nativeTools: config.nativeTools,
      baseEnv: { ...process.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: home.secureStorageDir },
      configuredEffort: (names) =>
        claudeConfiguredEffort(
          readClaudeUserSettings(
            selected.userConfiguration.mode === ProviderConfigurationMode.ISOLATED
              ? this.ctx.state.deviceHomes.claude
              : selected.sourceHome,
          ),
          { ...process.env, ...profile.env },
          names,
          runtime.claudeSettings?.effortLevel,
        ),
      profile: (id) => (profile.id === (id || "native") ? profile : undefined),
      publish: (event) => this.ctx.ops.publish(event),
      allowProviderTurn: (threadId, cwd) =>
        (this.ctx.state.nextWorkspaces.get(threadId) ?? this.ctx.state.cwds.get(threadId)) === cwd &&
        !this.ctx.state.closedThreads.has(threadId) &&
        !this.ctx.state.unloadingThreads.has(threadId) &&
        !this.ctx.state.rewindingThreads.has(threadId),
      onActivitySettled: () => {
        if (this.ctx.state.staleRuntimes.has(`claude/${profile.id}`))
          void this.ctx.ops.reconcileRuntimes().catch(() => {});
      },
      interact: (request) => this.ctx.ops.interact(request),
      callTool: this.ctx.ops.callTool,
      attachmentsDir: (threadId) => this.ctx.state.files.threadDir(threadId),
      secretsDir: (threadId) => this.ctx.state.secrets.threadDir(threadId),
      viewImage: (threadId, cwd, path) => this.ctx.ops.viewImage(threadId, cwd, path),
      localMcpServers: (tools, threadId, defaults) =>
        this.ctx.state.agentTools.localMcpServers(tools, threadId, defaults),
      recordEvent: (journal, threadId, init) =>
        this.ctx.state.previews.record(usage.failure(init), (event) => journal.append(threadId, event)),
      closingReason: () => this.ctx.ops.stopReason(),
    });

    const scope = await Effect.runPromise(Scope.make());
    const context = await this.ctx.state.options.runtime.runPromise(Layer.buildWithScope(layer, scope));
    this.ctx.state.claude.set(profile.id, { key, scope, context });
    this.ctx.ops.log("claude runtime started");
  }

  async stopClaude(id: string): Promise<void> {
    const claude = this.ctx.state.claude.get(id);

    if (!claude) return;
    const tasks = Context.get(claude.context, ClaudeThreads).backgroundTasks();
    this.ctx.state.claude.delete(id);
    await Effect.runPromise(Scope.close(claude.scope, Exit.void));
    await this.ctx.ops.closeOrphans(
      (threadId, item) => tasks.has(threadId) && kindOf(item) !== BackgroundTaskKind.PROCESS,
      this.ctx.ops.stopReason(),
    );
    this.ctx.ops.log("claude runtime stopped");
  }
}
