import { join } from "node:path";
import { homedir } from "node:os";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Provider, ConfigAppliedSchema } from "@canopy/contracts";
import { instanceShadowHome, type DeviceHomes } from "../config/remote.ts";
import { prepareCodexHome } from "../providers/codex/home.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { startCodexDeviceLogin } from "../providers/codex/login.ts";
import { providersOf } from "../providers/profiles.ts";
import { classifyInstanceCatalogs } from "../providers/model-metadata.ts";

import { CommandError, usableBy, type CommandOutput, type ProfileModelsInit } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class HostCatalog {
  constructor(readonly ctx: HostContext) {}
  /** Where instances live on this device (shadow homes, the device owner's logins). */
  homes(): DeviceHomes {
    return {
      dataDir: this.ctx.state.options.dataDir,
      claude: this.ctx.state.deviceHomes.claude,
      codex: this.ctx.state.deviceHomes.codex,
      grok: process.env["GROK_HOME"] || join(homedir(), ".grok"),
      env: process.env,
    };
  }

  /**
   * The current configuration checked again (versions, availability, logins: ProbeProviders, a finished sign-in):
   * a new ConfigApplied for the same version, then the model catalog.
   */
  async probe(): Promise<void> {
    const received = this.ctx.state.received;

    if (!received) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);
    const report = await this.ctx.ops.applyConfig(received);
    this.ctx.ops.send({ case: "configApplied", value: create(ConfigAppliedSchema, report) });
  }

  /** Codex sign-in from the app for an instance with its own login (device code); finishes in the background. */
  async startLogin(provider: Provider, profileId: string): Promise<NonNullable<CommandOutput["login"]>> {
    const config = this.ctx.state.config;

    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);

    if (provider !== Provider.CODEX) throw new CommandError("UNSUPPORTED", "only Codex signs in from the app", true);

    const status = config.profiles.find(
      (p) => p.config.id === (profileId || "native") && providersOf(p.config).includes("codex"),
    );

    if (!status) throw new CommandError("UNKNOWN_PROFILE", `unknown provider instance codex/${profileId}`, true);
    const runtime = status.config.runtime ?? {};

    if (status.config.kind !== "native" || !runtime.ownLogin)
      throw new CommandError("UNSUPPORTED", "only an instance with its own login signs in from the app", true);

    if (!config.codex.enabled || !config.codex.executable)
      throw new CommandError("PROVIDER_UNAVAILABLE", config.codex.problem ?? "codex is disabled", false);

    const home = prepareCodexHome({
      dataDir: this.ctx.state.options.dataDir,
      path: instanceShadowHome(this.ctx.state.options.dataDir, "codex", status.config.id, runtime)!,
      ownLogin: true,
      linkDeviceLogin: false,
    });

    const env = Object.fromEntries((status.config.env ?? []).map((v) => [v.name, v.value]));

    const login = await startCodexDeviceLogin({
      launch: codexAppServerLaunch(
        [],
        process.env,
        runtime.executablePath || config.codex.executable,
        config.nativeTools,
        home.path,
        env,
      ),
      clientVersion: this.ctx.state.options.clientVersion,
    }).catch((cause: unknown) => {
      throw new CommandError("LOGIN_FAILED", cause instanceof Error ? cause.message : String(cause), false);
    });

    const key = `codex/${status.config.id}`;

    const done = login.done.then(async (outcome) => {
      this.ctx.ops.log(
        `codex sign-in of ${status.config.id}: ${outcome.success ? "signed in" : (outcome.error ?? "failed")}`,
      );
      this.ctx.state.logins.delete(key);
      this.ctx.state.accounts.invalidate();
      // The new login shows in the report; Codex processes of the instance pick it up when they restart.
      await this.ctx.ops.probe().catch(() => {});
    });

    this.ctx.state.logins.set(key, done);

    return { verificationUrl: login.verificationUrl, userCode: login.userCode, loginId: login.loginId };
  }

  /** Lists every provider + profile of the current config and sends the catalog (the newest run wins). */
  async publishCatalog(configVersion: bigint): Promise<void> {
    const run = ++this.ctx.state.catalogRun;
    const profiles = await this.ctx.ops.listModels(Provider.UNSPECIFIED, "");

    if (run !== this.ctx.state.catalogRun) return;
    this.ctx.state.catalog = { configVersion, profiles };
    this.ctx.ops.send({ case: "modelCatalog", value: this.ctx.state.catalog });
    this.ctx.ops.log(
      `model catalog: ${profiles.map((p) => `${Provider[p.provider ?? 0]?.toLowerCase()}/${p.profileId} ${p.models?.length ?? 0}${p.detail ? " (incomplete)" : ""}`).join(", ")}`,
    );
  }

  /** Models of the enabled providers' usable profiles; a failing pair reports its problem instead. */
  async listModels(provider: Provider, profileId: string): Promise<ProfileModelsInit[]> {
    const config = this.ctx.state.config;

    if (!config) return [];
    const pairs: { provider: Provider; profile: string }[] = [];

    for (const status of config.profiles) {
      const resolved = status.resolved;

      if (!resolved || (profileId && resolved.id !== profileId)) continue;

      if (
        this.ctx.state.claude.has(resolved.id) &&
        usableBy(resolved, "claude") &&
        (!provider || provider === Provider.CLAUDE)
      )
        pairs.push({ provider: Provider.CLAUDE, profile: resolved.id });

      if (this.ctx.state.codex.size > 0 && usableBy(resolved, "codex") && (!provider || provider === Provider.CODEX))
        pairs.push({ provider: Provider.CODEX, profile: resolved.id });

      if (
        this.ctx.state.grok.has(resolved.id) &&
        usableBy(resolved, "grok") &&
        (!provider || provider === Provider.GROK)
      )
        pairs.push({ provider: Provider.GROK, profile: resolved.id });
    }

    const lists = await Promise.all(
      pairs.map(async ({ provider: p, profile }): Promise<ProfileModelsInit> => {
        try {
          const listed: { models: ProfileModelsInit["models"]; detail?: string } =
            p === Provider.GROK
              ? await this.ctx.ops.runGrok((threads) => threads.listModels(profile), profile)
              : p === Provider.CLAUDE
                ? await this.ctx.ops.runClaude((threads) => threads.listModels(profile), profile)
                : await this.ctx.ops.runCodex(
                    Provider.CODEX,
                    (threads) => threads.listModels(profile),
                    this.ctx.ops.codexGroupOf(profile),
                  );

          return {
            provider: p,
            profileId: profile,
            models: listed.models ?? [],
            ...(listed.detail && { detail: listed.detail }),
            listedAt: timestampNow(),
          };
        } catch (error) {
          return {
            provider: p,
            profileId: profile,
            models: [],
            detail: error instanceof Error ? error.message : String(error),
            listedAt: timestampNow(),
          };
        }
      }),
    );

    return classifyInstanceCatalogs(lists);
  }
}
