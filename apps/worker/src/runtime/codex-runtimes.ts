import { BackgroundTaskKind, Provider, type Item } from "@canopy/contracts";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { prepareCodexHome } from "../providers/codex/home.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { readCodexConfiguredEffort } from "../providers/default-effort.ts";
import { hasOwnRuntime, type ProfileRuntimeConfig, type ResolvedProfile } from "../providers/profiles.ts";

import {
  CommandError,
  SHARED_CODEX,
  kindOf,
  taskOf,
  usableBy,
  hasEnv,
  codexProfileGroup,
  type CodexGroup,
} from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class CodexRuntimes {
  constructor(readonly ctx: HostContext) {}
  async runCodex<A, E>(
    provider: Provider,
    use: (threads: CodexThreads["Service"]) => Effect.Effect<A, E>,
    group: string,
  ): Promise<A> {
    if (provider !== Provider.CODEX)
      throw new CommandError("PROVIDER_UNAVAILABLE", `${Provider[provider]} is not supported by this worker yet`, true);
    await this.ctx.ops.restartFailedCodex(group);
    const codex = this.ctx.state.codex.get(group);

    if (!codex)
      throw new CommandError(
        "PROVIDER_UNAVAILABLE",
        this.ctx.state.config?.codex.problem ?? "codex is disabled",
        false,
      );

    return this.ctx.ops.runIn(Effect.provide(CodexThreads.use(use), codex.context));
  }

  /** The Codex process for a profile: its own when it has variables, else the shared one. */
  codexGroupOf(profileId: string): string {
    const group = codexProfileGroup(profileId || "native");

    return this.ctx.state.codex.has(group) ? group : SHARED_CODEX;
  }

  /** The Codex process that has the thread loaded (it runs the thread's turn), else the shared one. */
  codexGroupWith(threadId: string): string {
    return (
      [...this.ctx.state.codex].find(([, codex]) => Context.get(codex.context, CodexThreads).has(threadId))?.[0] ??
      SHARED_CODEX
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

  /** Wanted Codex processes: the shared one, and one per usable profile with its own variables. */
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
      }),
    });

    // The shared process always runs: threads of an unknown or unavailable profile get its error from it.
    // Variables and an own runtime (executable, homes, arguments) belong to a process: such an instance gets its own.
    const own = (p: ResolvedProfile) => hasEnv(p) || hasOwnRuntime(p.runtime ?? {});
    groups.set(
      SHARED_CODEX,
      group(
        usable.filter((p) => !own(p)),
        {},
        {},
      ),
    );

    for (const profile of usable.filter(own))
      groups.set(codexProfileGroup(profile.id), group([profile], profile.env, profile.runtime ?? {}, profile.id));

    return groups;
  }

  async startCodex(name: string, group: CodexGroup): Promise<void> {
    const config = this.ctx.state.config;

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
      configuredEffort: () => readCodexConfiguredEffort(deviceHome),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.ctx.ops.publish(event),
      interact: (request) => this.ctx.ops.interact(request),
      callTool: (call) => this.ctx.ops.callTool(call),
      viewImage: (threadId, path) => this.ctx.ops.viewImage(threadId, this.ctx.state.cwds.get(threadId) ?? "", path),
      enrich: (init) => this.ctx.state.previews.enrich(init),
      connectors: config.nativeTools.nativeConnectors === true,
    });

    const scope = await Effect.runPromise(Scope.make());
    const context = await this.ctx.state.options.runtime.runPromise(Layer.buildWithScope(layer, scope));
    this.ctx.state.codex.set(name, { key: group.key, scope, context });
    this.ctx.ops.log(`codex runtime started${name === SHARED_CODEX ? "" : ` (${name})`}`);
  }

  async stopCodex(name: string): Promise<void> {
    const codex = this.ctx.state.codex.get(name);

    if (!codex) return;
    this.ctx.state.codex.delete(name);
    await Effect.runPromise(Scope.close(codex.scope, Exit.void));
    this.ctx.ops.log(`codex runtime stopped${name === SHARED_CODEX ? "" : ` (${name})`}`);
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
