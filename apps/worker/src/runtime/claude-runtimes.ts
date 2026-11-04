import { BackgroundTaskKind } from "@canopy/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { prepareClaudeHome } from "../providers/claude/home.ts";
import { claudeExtraArgs, ClaudeThreads, type ClaudeInstanceRuntime } from "../providers/claude/threads.ts";
import { claudeConfiguredEffort, readClaudeUserSettings } from "../providers/default-effort.ts";
import { hasOwnRuntime } from "../providers/profiles.ts";

import { CommandError, kindOf, usableBy } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class ClaudeRuntimes {
  constructor(readonly ctx: HostContext) {}
  async runClaude<A, E>(use: (threads: ClaudeThreads["Service"]) => Effect.Effect<A, E>): Promise<A> {
    if (!this.ctx.state.claude)
      throw new CommandError(
        "PROVIDER_UNAVAILABLE",
        this.ctx.state.config?.claude.problem ?? "claude is disabled",
        false,
      );

    return this.ctx.ops.runIn(Effect.provide(ClaudeThreads.use(use), this.ctx.state.claude.context));
  }

  claudeKey(config: AppliedConfig): string | undefined {
    if (!config.claude.enabled) return undefined;

    return JSON.stringify({
      executable: config.claude.executable,
      linkDeviceLogin: config.claude.linkDeviceLogin,
      nativeTools: config.nativeTools,
      profiles: config.profiles.map((p) => p.resolved ?? null),
    });
  }

  async reconcileClaude(config: AppliedConfig | undefined, key: string | undefined): Promise<void> {
    await this.ctx.ops.stopClaude();

    if (!config || !key) return;

    const home = prepareClaudeHome({
      dataDir: this.ctx.state.options.dataDir,
      linkDeviceLogin: config.claude.linkDeviceLogin,
      deviceClaudeHome: this.ctx.state.deviceHomes.claude,
    });

    if (home.problem) this.ctx.ops.log(`claude home: ${home.problem}`);
    this.ctx.state.claudeHome = home.path;
    this.ctx.state.catalogs.clear();
    const profiles = config.profiles.flatMap((p) => (p.resolved && usableBy(p.resolved, "claude") ? [p.resolved] : []));
    // Instances with their own runtime: their config dir (own login or login source), executable and flags.
    const runtimes = new Map<string, ClaudeInstanceRuntime>();

    for (const profile of profiles) {
      const runtime = profile.runtime ?? {};

      if (!hasOwnRuntime(runtime)) continue;
      const shadow = instanceShadowHome(this.ctx.state.options.dataDir, "claude", profile.id, runtime);

      const own = shadow
        ? prepareClaudeHome({
            dataDir: this.ctx.state.options.dataDir,
            path: shadow,
            ...(runtime.ownLogin && { ownLogin: true }),
            linkDeviceLogin: config.claude.linkDeviceLogin,
            deviceClaudeHome: runtime.homePath || this.ctx.state.deviceHomes.claude,
          })
        : home;

      if (own.problem) this.ctx.ops.log(`claude home of ${profile.id}: ${own.problem}`);
      const executable = runtime.executablePath || config.claude.executable;
      runtimes.set(profile.id, {
        home: own.path,
        ...(executable && { executable }),
        extraArgs: claudeExtraArgs(runtime.launchArgs ?? []),
      });
    }

    const layer = ClaudeThreads.layer({
      home: home.path,
      ...(config.claude.executable && { executable: config.claude.executable }),
      runtimeOf: (profile) => runtimes.get(profile.id),
      nativeTools: config.nativeTools,
      baseEnv: process.env,
      configuredEffort: (names) =>
        claudeConfiguredEffort(readClaudeUserSettings(this.ctx.state.deviceHomes.claude), process.env, names),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.ctx.ops.publish(event),
      interact: (request) => this.ctx.ops.interact(request),
      callTool: (call) => this.ctx.ops.callTool(call),
      attachmentsDir: (threadId) => this.ctx.state.files.threadDir(threadId),
      secretsDir: (threadId) => this.ctx.state.secrets.threadDir(threadId),
      viewImage: (threadId, cwd, path) => this.ctx.ops.viewImage(threadId, cwd, path),
      enrich: (init) => this.ctx.state.previews.enrich(init),
      closingReason: () => this.ctx.ops.stopReason(),
    });

    const scope = await Effect.runPromise(Scope.make());
    const context = await this.ctx.state.options.runtime.runPromise(Layer.buildWithScope(layer, scope));
    this.ctx.state.claude = { key, scope, context };
    this.ctx.ops.log("claude runtime started");
  }

  async stopClaude(): Promise<void> {
    const claude = this.ctx.state.claude;

    if (!claude) return;
    this.ctx.state.claude = undefined;
    await Effect.runPromise(Scope.close(claude.scope, Exit.void));
    await this.ctx.ops.closeOrphans(
      (_, item) => kindOf(item) !== BackgroundTaskKind.PROCESS,
      this.ctx.ops.stopReason(),
    );
    this.ctx.ops.log("claude runtime stopped");
  }
}
