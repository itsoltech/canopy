import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Provider, type Command } from "@canopy/contracts";
import { claudeCatalogStamp } from "../providers/claude/catalog.ts";
import { searchFiles } from "../files/search.ts";

import type { CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class QueryCommands {
  constructor(readonly ctx: HostContext) {}
  async listModelsCommand(kind: Extract<Command["kind"], { case: "listModels" }>): Promise<CommandOutput> {
    return { models: await this.ctx.ops.listModels(kind.value.provider, kind.value.profileId) };
  }

  async probeProviders(): Promise<CommandOutput> {
    await this.ctx.ops.probe();
    void this.ctx.state.cli.report().catch(() => undefined);

    return {};
  }

  async startLoginCommand(kind: Extract<Command["kind"], { case: "startLogin" }>): Promise<CommandOutput> {
    return { login: await this.ctx.ops.startLogin(kind.value.provider, kind.value.profileId) };
  }

  async listMentionCatalog(kind: Extract<Command["kind"], { case: "listMentionCatalog" }>): Promise<CommandOutput> {
    const { provider, refresh } = kind.value;
    const cwd = kind.value.cwd || homedir();
    const profileId = kind.value.profileId || "native";
    this.ctx.ops.checkCwd(cwd);
    const folder = realpathSync(cwd);

    const listed =
      provider === Provider.GROK
        ? { entries: [], notes: ["Grok ACP does not expose a mention catalog"] }
        : provider === Provider.CLAUDE
          ? await this.ctx.state.catalogs.get(
              `claude|${profileId}|${folder}`,
              claudeCatalogStamp(folder, this.ctx.state.claudeHome),
              () => this.ctx.ops.runClaude((threads) => threads.listMentionCatalog(profileId, folder)),
              refresh,
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

  async searchFiles(kind: Extract<Command["kind"], { case: "searchFiles" }>): Promise<CommandOutput> {
    const { cwd, query, limit } = kind.value;
    this.ctx.ops.checkCwd(cwd);
    const found = await searchFiles(cwd, query, limit);

    return { fileSearch: { ...found, matches: found.matches.map((m) => ({ ...m, indices: [...m.indices] })) } };
  }
}
