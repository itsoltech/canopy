import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Provider, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import { claudeCatalogStamp } from "../providers/claude/catalog.ts";
import { claudeConfigurationHomes } from "../providers/claude/configuration-homes.ts";
import { providersOf } from "../providers/profiles.ts";
import { searchFiles } from "../files/search.ts";

import { acpHarness, type CommandOutput } from "./host-types.ts";
import { refreshShellEnv } from "../cli-tools/shell-env.ts";
import type { HostContext } from "./host-context.ts";

export class QueryCommands {
  constructor(readonly ctx: HostContext) {}
  async listModelsCommand(kind: Extract<Command["kind"], { case: "listModels" }>): Promise<CommandOutput> {
    return { models: await this.ctx.ops.listModels(kind.value.provider, kind.value.profileId) };
  }

  async probeProviders(): Promise<CommandOutput> {
    this.ctx.state.accounts.invalidate();
    // A CLI installed since the worker started may have changed the user's shell profile.
    await refreshShellEnv();
    await this.ctx.ops.probe();
    void this.ctx.state.cli.report().catch(() => undefined);

    return {};
  }

  async listMentionCatalog(kind: Extract<Command["kind"], { case: "listMentionCatalog" }>): Promise<CommandOutput> {
    const { provider, refresh } = kind.value;
    const cwd = kind.value.cwd || homedir();
    const profileId = kind.value.profileId || "native";
    this.ctx.ops.checkCwd(cwd);
    const folder = realpathSync(cwd);

    const listed = acpHarness(provider)
      ? { entries: [], notes: ["The mention catalog is unavailable for this agent."] }
      : provider === Provider.CLAUDE
        ? await this.ctx.ops.runClaude(
            (threads) =>
              Effect.promise(() =>
                this.ctx.state.catalogs.get(
                  `claude|${profileId}|${folder}`,
                  this.#claudeStamp(folder, profileId),
                  () => this.ctx.ops.runIn(threads.listMentionCatalog(profileId, folder)),
                  refresh,
                ),
              ),
            profileId,
          )
        : await this.ctx.ops.runCodex(
            provider,
            (threads) => threads.listMentionCatalog(folder, refresh),
            this.ctx.ops.codexGroupOf(profileId),
          );

    return {
      mentionCatalog: {
        provider,
        profileId,
        cwd: folder,
        entries: listed.entries,
        notes: listed.notes,
        listedAt: timestampNow(),
      },
    };
  }

  #claudeStamp(folder: string, profileId: string): string {
    const profile = this.ctx.state.config?.profiles.find(
      (entry) => entry.config.id === profileId && providersOf(entry.config).includes("claude"),
    );

    const selected = claudeConfigurationHomes(
      this.ctx.state.options.dataDir,
      profileId,
      profile?.config.runtime,
      this.ctx.state.deviceHomes.claude,
    );

    return `${this.ctx.state.claude.get(profileId)?.key}|${claudeCatalogStamp(folder, selected.sourceHome)}|${claudeCatalogStamp(folder, selected.platformHome)}`;
  }

  async searchFiles(kind: Extract<Command["kind"], { case: "searchFiles" }>): Promise<CommandOutput> {
    const { cwd, query, limit } = kind.value;
    this.ctx.ops.checkCwd(cwd);
    const found = await searchFiles(cwd, query, limit);

    return { fileSearch: { ...found, matches: found.matches.map((m) => ({ ...m, indices: [...m.indices] })) } };
  }
}
