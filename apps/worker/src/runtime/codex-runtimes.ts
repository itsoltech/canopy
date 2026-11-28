import { BackgroundTaskKind, Provider, type Item } from "@canopy/contracts";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { prepareCodexInstanceHome } from "../providers/codex/home.ts";
import { codexLoginProblems } from "@canopy/domain/provider-accounts";
import { CodexAppServerStartupError } from "../providers/codex/app-server.ts";
import { codexAppServerLaunch, codexThreadLaunchArgs } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { prepareImportedCodexResume } from "../import/codex-provider.ts";
import { readCodexConfiguredEffort } from "../providers/default-effort.ts";
import { join, resolve } from "node:path";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";

import { CommandError, kindOf, taskOf, usableBy, codexProfileGroup, type CodexGroup } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { reportsPlanUsage, usageReporter } from "./usage-limits.ts";

function privatePolicyDirectory(path: string): string | undefined {
  if (process.platform !== "linux") return undefined;

  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);

    if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700) return canonical;
  } catch {
    return undefined;
  }

  return undefined;
}

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

    if (!config.codex.enabled) return groups;

    // Separate processes even when env/homes match: one instance must drain independently of the others.
    for (const { resolved: profile, codexLoginRevision } of config.profiles) {
      if (!profile || !usableBy(profile, "codex") || !(profile.runtime.executablePath || config.codex.executable))
        continue;
      const profiles = [profile];
      groups.set(codexProfileGroup(profile.id), {
        profiles,
        env: profile.env,
        runtime: profile.runtime,
        id: profile.id,
        key: JSON.stringify({
          executable: config.codex.executable,
          version: config.codex.version,
          linkDeviceLogin: config.codex.linkDeviceLogin,
          nativeTools: config.nativeTools,
          profiles,
          // A CLI login can change outside Canopy while a running app-server caches the previous credentials.
          codexLoginRevision,
          login: this.ctx.state.loginGenerations.get(`codex/${profile.id}`) ?? 0,
        }),
      });
    }

    return groups;
  }

  async startCodex(
    name: string,
    group: CodexGroup,
    config: AppliedConfig | undefined = this.ctx.state.config,
  ): Promise<void> {
    if (!config) return;
    const { profiles, runtime } = group;

    const dataDir = this.ctx.state.options.dataDir;

    const privateHome = resolve(
      instanceShadowHome(dataDir, "codex", group.id ?? "native", runtime) ?? join(dataDir, "codex-home"),
    );

    const deviceHome = this.ctx.state.deviceHomes.codex;

    const home = prepareCodexInstanceHome(profiles[0]!, {
      dataDir,
      path: privateHome,
      linkDeviceLogin: config.codex.linkDeviceLogin,
      deviceHome,
    });

    const cliHomes = home.login === "cli" ? { cliHome: home.path, privateHome } : undefined;

    if (cliHomes) mkdirSync(privateHome, { recursive: true, mode: 0o700 });

    if (home.problem) this.ctx.ops.log(`codex home: ${home.problem}`);

    if (home.linkFailed && profiles.some((profile) => profile.kind === "native"))
      throw new CommandError("PROVIDER_UNAVAILABLE", home.problem ?? codexLoginProblems.link, true);
    // Protect the real private Codex policy and credentials from shell reads in a profiled session.
    const policyDirectory = home.login === "none" ? privatePolicyDirectory(home.path) : undefined;

    const plan = reportsPlanUsage(profiles, process.env);
    const usage = usageReporter(this.ctx, Provider.CODEX, group.id ?? "native", home.path, group.key, plan);

    const layer = CodexThreads.layer({
      pricing: this.ctx.state.pricing,
      launch: codexAppServerLaunch(
        profiles,
        process.env,
        runtime.executablePath || config.codex.executable,
        config.nativeTools,
        cliHomes ?? home.path,
        group.env,
        codexThreadLaunchArgs([
          ...(runtime.launchArgs ?? []),
          ...(cliHomes
            ? [
                "-c",
                `sqlite_home=${JSON.stringify(privateHome)}`,
                "-c",
                "features.background_paginated_rollout_migration=false",
              ]
            : []),
        ]),
      ),
      clientVersion: this.ctx.state.options.clientVersion,
      ...(policyDirectory && { sandboxProfileRuntime: { policyDirectory } }),
      onUsage: usage.report,
      readQuota: plan,
      configuredEffort: () => readCodexConfiguredEffort(runtime.homePath || deviceHome),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      ...(cliHomes && { previousPrivateHome: privateHome }),
      importedResumePath: (spec, provider) => {
        const manifest = this.ctx.state.imports.copyManifest("codex", spec.providerProfileId, spec.providerThreadId);

        if (cliHomes) {
          if (lstatSync(manifest, { throwIfNoEntry: false }))
            throw new Error(
              "Switch this instance to an isolated Codex home to continue the imported thread from its private copy.",
            );

          return undefined;
        }

        return prepareImportedCodexResume(manifest, privateHome, spec.providerThreadId, provider);
      },
      publish: (event) => this.ctx.ops.publish(event),
      log: (message) => this.ctx.ops.log(message),
      onActivitySettled: () => {
        if (this.ctx.state.staleRuntimes.has(`codex/${name}`)) void this.ctx.ops.reconcileRuntimes().catch(() => {});
      },
      interact: (request) => this.ctx.ops.interact(request),
      callTool: this.ctx.ops.callTool,
      viewImage: (threadId, path) => this.ctx.ops.viewImage(threadId, this.ctx.state.cwds.get(threadId) ?? "", path),
      localMcpServers: (tools, threadId, defaults) =>
        this.ctx.state.agentTools.localMcpServers(tools, threadId, defaults),
      recordEvent: (journal, threadId, init) => {
        const cwd = this.ctx.state.cwds.get(threadId);
        const result = usage.failure(init);
        const append = (event: typeof init) => journal.append(threadId, event);

        if (!cwd) return this.ctx.state.previews.record(result, append);
        const generated = join(home.path, "generated_images");

        return this.ctx.state.previews.record(result, append, {
          native: { cwd, roots: [cwd, this.ctx.state.files.threadDir(threadId)] },
          generated: { cwd, roots: [cwd, generated] },
        });
      },
      connectors: config.nativeTools.nativeConnectors === true,
    });

    const scope = await Effect.runPromise(Scope.make());

    const context = await this.ctx.state.options.runtime
      .runPromise(Layer.buildWithScope(layer, scope))
      .catch(async (error) => {
        if (error instanceof CodexAppServerStartupError) this.ctx.ops.log(error.message);
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
