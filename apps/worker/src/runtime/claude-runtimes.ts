import { BackgroundTaskKind } from "@canopy/contracts";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { instanceShadowHome } from "../config/remote.ts";
import { prepareClaudeHome } from "../providers/claude/home.ts";
import { claudeExtraArgs, ClaudeThreads } from "../providers/claude/threads.ts";
import { claudeConfiguredEffort, readClaudeUserSettings } from "../providers/default-effort.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import type { AppliedConfig } from "../config/remote.ts";

import { CommandError, kindOf } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

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
    const shadow = instanceShadowHome(this.ctx.state.options.dataDir, "claude", profile.id, runtime);

    const home = prepareClaudeHome({
      dataDir: this.ctx.state.options.dataDir,
      ...(shadow && { path: shadow }),
      ...(runtime.ownLogin && { ownLogin: true }),
      linkDeviceLogin: config.claude.linkDeviceLogin,
      deviceClaudeHome: runtime.homePath || this.ctx.state.deviceHomes.claude,
    });

    if (home.problem) this.ctx.ops.log(`claude home: ${home.problem}`);
    this.ctx.state.claudeHomes.set(profile.id, home.path);
    const executable = runtime.executablePath || config.claude.executable;

    const layer = ClaudeThreads.layer({
      home: home.path,
      ...(executable && { executable }),
      runtimeOf: () => ({
        home: home.path,
        ...(executable && { executable }),
        extraArgs: claudeExtraArgs(runtime.launchArgs ?? []),
      }),
      nativeTools: config.nativeTools,
      baseEnv: process.env,
      configuredEffort: (names) =>
        claudeConfiguredEffort(readClaudeUserSettings(this.ctx.state.deviceHomes.claude), process.env, names),
      profile: (id) => (profile.id === (id || "native") ? profile : undefined),
      publish: (event) => this.ctx.ops.publish(event),
      allowProviderTurn: (threadId) => !this.ctx.state.closedThreads.has(threadId),
      onActivitySettled: () => {
        if (this.ctx.state.staleRuntimes.has(`claude/${profile.id}`))
          void this.ctx.ops.reconcileRuntimes().catch(() => {});
      },
      interact: (request) => this.ctx.ops.interact(request),
      callTool: (call, signal) => this.ctx.ops.callTool(call, signal),
      attachmentsDir: (threadId) => this.ctx.state.files.threadDir(threadId),
      secretsDir: (threadId) => this.ctx.state.secrets.threadDir(threadId),
      viewImage: (threadId, cwd, path) => this.ctx.ops.viewImage(threadId, cwd, path),
      enrich: (init) => this.ctx.state.previews.enrich(init),
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
