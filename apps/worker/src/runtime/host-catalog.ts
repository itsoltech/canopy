import { join } from "node:path";
import { homedir } from "node:os";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Provider, ConfigAppliedSchema } from "@canopy/contracts";
import { type DeviceHomes } from "../config/remote.ts";
import { classifyInstanceCatalogs } from "../providers/model-metadata.ts";

import { CommandError, usableBy, type ProfileModelsInit } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class HostCatalog {
  constructor(readonly ctx: HostContext) {}
  /** Where instances live on this device (shadow homes, the device owner's logins). */
  homes(): DeviceHomes {
    return {
      dataDir: this.ctx.state.options.dataDir,
      claude: this.ctx.state.deviceHomes.claude,
      codex: this.ctx.state.deviceHomes.codex,
      grok: this.ctx.state.deviceHomes.grok ?? join(homedir(), ".grok"),
      ...(this.ctx.state.deviceHomes.grokAuthPath && { grokAuthPath: this.ctx.state.deviceHomes.grokAuthPath }),
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
