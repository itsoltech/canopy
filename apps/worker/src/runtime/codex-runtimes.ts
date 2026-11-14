import { BackgroundTaskKind, Provider, type Item } from "@canopy/contracts";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { prepareCodexHome } from "../providers/codex/home.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { prepareImportedCodexResume } from "../import/codex-provider.ts";
import { readCodexConfiguredEffort } from "../providers/default-effort.ts";
import { type ProfileRuntimeConfig, type ResolvedProfile } from "../providers/profiles.ts";

import { CommandError, kindOf, taskOf, usableBy, codexProfileGroup, type CodexGroup } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { reportsPlanUsage, usageReporter } from "./usage-limits.ts";

export class CodexRuntimes {
  constructor(readonly ctx: HostContext) {}
  async runCodex<A, E>(
    provider: Provider,
    use: (threads: CodexThreads["Service"]) => Effect.Effect<A, E>,
    group: string,
    current = false,
  ): Promise<A> {
    if (provider !== Provider.CODEX)
      throw new CommandError("PROVIDER_UNAVAILABLE", `${Provider[provider]} is not supported by this worker yet`, true);

    return this.ctx.ops.useRuntime(`codex/${group}`, current, async () => {
      await this.ctx.ops.restartFailedCodex(group);
      const codex = this.ctx.state.codex.get(group);

      if (!codex)
        throw new CommandError(
          "PROVIDER_UNAVAILABLE",
          this.ctx.state.config?.codex.problem ?? "codex is disabled",
          false,
        );

      return this.ctx.ops.runIn(Effect.provide(CodexThreads.use(use), codex.context));
    });
  }

  /** Every instance drains its own Codex process independently. */
  codexGroupOf(profileId: string): string {
    return codexProfileGroup(profileId || "native");
  }

  /** The Codex process that has the thread loaded (it runs the thread's turn). */
  codexGroupWith(threadId: string): string {
    return (
      [...this.ctx.state.codex].find(([, codex]) => Context.get(codex.context, CodexThreads).has(threadId))?.[0] ??
      this.ctx.state.threadInstances.get(threadId)?.slice("codex/".length) ??
      ""
    );
  }

  /**
   * The app-server exited on its own (its turns are already settled from their rollouts): the next command gets a
   * new one. Threads resume in it (thread/resume), so they stay usable.
   */
  async restartFailedCodex(group: string): Promise<void> {
    const codex = this.ctx.state.codex.get(group);
    const failure = codex && Context.get(codex.context, CodexThreads).failure();

    if (!failure) return;
    let restart = this.ctx.state.codexRestart.get(group);

    if (!restart) {
      restart = (async () => {
        this.ctx.ops.log(`${failure}; starting a new one`);
        await this.ctx.ops.stopCodex(group);
        await this.ctx.ops.closeCodexOrphans();
        const wanted = this.ctx.state.config ? this.ctx.ops.codexGroups(this.ctx.state.config).get(group) : undefined;

        if (wanted) await this.ctx.ops.startCodex(group, wanted);
      })().finally(() => this.ctx.state.codexRestart.delete(group));
      this.ctx.state.codexRestart.set(group, restart);
    }

    await restart;
  }

  /** One wanted Codex process per usable instance. */
  codexGroups(config: AppliedConfig): Map<string, CodexGroup> {
    const groups = new Map<string, CodexGroup>();

    if (!config.codex.enabled || !config.codex.executable) return groups;
    const usable = config.profiles.flatMap((p) => (p.resolved && usableBy(p.resolved, "codex") ? [p.resolved] : []));

    const group = (
      profiles: ResolvedProfile[],
      env: Readonly<Record<string, string>>,
      runtime: ProfileRuntimeConfig,
      id?: string,
    ): CodexGroup => ({
      profiles,
      env,
      runtime,
      ...(id !== undefined && { id }),
      key: JSON.stringify({
        executable: config.codex.executable,
        // A new CLI version (an install from the app) restarts the process once it is idle.
        version: config.codex.version,
        linkDeviceLogin: config.codex.linkDeviceLogin,
        nativeTools: config.nativeTools,
        profiles,
        // A sign-in from the app: the process starts again with the new login instead of a cached rejection.
        login: id === undefined ? 0 : (this.ctx.state.loginGenerations.get(id) ?? 0),
      }),
    });

    // Separate processes even when env/homes match: one instance must drain independently of the others.
    for (const profile of usable)
      groups.set(codexProfileGroup(profile.id), group([profile], profile.env, profile.runtime ?? {}, profile.id));

    return groups;
  }

  async startCodex(
    name: string,
    group: CodexGroup,
    config: AppliedConfig | undefined = this.ctx.state.config,
  ): Promise<void> {
    if (!config) return;
    const { profiles, runtime } = group;

    const shadow =
      group.id !== undefined
        ? instanceShadowHome(this.ctx.state.options.dataDir, "codex", group.id, runtime)
        : undefined;

    const deviceHome = runtime.homePath || this.ctx.state.deviceHomes.codex;

    const home = prepareCodexHome({
      dataDir: this.ctx.state.options.dataDir,
      ...(shadow && { path: shadow }),
      ...(runtime.ownLogin && { ownLogin: true }),
      linkDeviceLogin: config.codex.linkDeviceLogin,
      deviceCodexHome: deviceHome,
    });

    if (home.problem) this.ctx.ops.log(`codex home: ${home.problem}`);

    const usage = usageReporter(
      this.ctx,
      Provider.CODEX,
      group.id ?? "native",
      home.path,
      group.key,
      reportsPlanUsage(profiles, process.env),
    );

    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch(
        profiles,
        process.env,
        runtime.executablePath || config.codex.executable,
        config.nativeTools,
        home.path,
        group.env,
        runtime.launchArgs,
      ),
      clientVersion: this.ctx.state.options.clientVersion,
      onUsage: usage.report,
      configuredEffort: () => readCodexConfiguredEffort(deviceHome),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      importedResumePath: (spec, provider) =>
        prepareImportedCodexResume(
          this.ctx.state.imports.copyManifest("codex", spec.providerProfileId, spec.providerThreadId),
          home.path,
          spec.providerThreadId,
          provider,
        ),
      publish: (event) => this.ctx.ops.publish(event),
      log: (message) => this.ctx.ops.log(message),
      onActivitySettled: () => {
        if (this.ctx.state.staleRuntimes.has(`codex/${name}`)) void this.ctx.ops.reconcileRuntimes().catch(() => {});
      },
      interact: (request) => this.ctx.ops.interact(request),
      callTool: (call) => this.ctx.ops.callTool(call),
      viewImage: (threadId, path) => this.ctx.ops.viewImage(threadId, this.ctx.state.cwds.get(threadId) ?? "", path),
      enrich: (init) => this.ctx.state.previews.enrich(usage.failure(init)),
      connectors: config.nativeTools.nativeConnectors === true,
    });

    const scope = await Effect.runPromise(Scope.make());

    const context = await this.ctx.state.options.runtime
      .runPromise(Layer.buildWithScope(layer, scope))
      .catch(async (error) => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
      });

    this.ctx.state.codex.set(name, { key: group.key, scope, context });
    this.ctx.ops.log(`codex runtime started (${name})`);
  }

  async stopCodex(name: string): Promise<void> {
    const codex = this.ctx.state.codex.get(name);

    if (!codex) return;
    this.ctx.state.codex.delete(name);
    await Effect.runPromise(Scope.close(codex.scope, Exit.void));
    this.ctx.ops.log(`codex runtime stopped (${name})`);
  }

  /** Codex background processes the journal has open that no running Codex process holds any more. */
  async closeCodexOrphans(): Promise<void> {
    const held = (threadId: string, item: Item) =>
      [...this.ctx.state.codex.values()].some((codex) =>
        Context.get(codex.context, CodexThreads)
          .backgroundTasks()
          .get(threadId)
          ?.includes(taskOf(item) ?? ""),
      );

    await this.ctx.ops.closeOrphans(
      (threadId, item) => kindOf(item) === BackgroundTaskKind.PROCESS && !held(threadId, item),
      this.ctx.ops.stopReason(),
    );
  }
}
