import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { checkSkillPath, SKILL_TOTAL_BYTES, skillName } from "@canopy/domain/skill-artifact";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { pluginHarnesses } from "@canopy/domain/plugin-components";
import { Option, Schema } from "effect";
import { sourceInvalid, sourceReference } from "./source-command.ts";
import { gitFile, readGitSource, type SourceTransport } from "./source-git.ts";

const Catalog = Schema.Struct({
  name: Schema.String,
  plugins: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.Json })),
});

const LocalSource = Schema.Struct({ source: Schema.Literal("local"), path: Schema.String });

export function marketplaceReference(command: string) {
  const input = command.trim().replace(/^(?:\/plugin|claude plugin|codex plugin) marketplace add\s+/, "");

  if (/[\s`$;&|<>\\]/.test(input) || input.length > 4096)
    sourceInvalid("Paste one marketplace repository or marketplace add command.");
  const parsed = sourceReference(input);

  if (parsed.filter || parsed.source.path)
    sourceInvalid("Use the marketplace repository root, optionally pinned with #ref.");

  return parsed.source;
}

export function installReference(command: string) {
  const input = command.trim().replace(/^(?:\/plugin install|claude plugin install|codex plugin add)\s+/, "");
  const match = input.match(/^([a-z0-9-]+)(?:@([a-z0-9-]+))?$/);

  if (!match || !skillName(match[1]!))
    sourceInvalid("Use /plugin install name@marketplace, without flags or shell operators.");

  return { name: match[1]!, marketplace: match[2] ?? "" };
}

export async function discoverMarketplace(source: ui.SkillSource, authorization: string, options: SourceTransport) {
  return readGitSource(source, authorization, options, async (commit, entries, blob) => {
    const marker = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]
      .map((path) => entries.find((e) => e.path === path))
      .find(Boolean);

    if (!marker) sourceInvalid("No .claude-plugin/marketplace.json or .agents/plugins/marketplace.json found.");
    const catalog = Schema.decodeUnknownSync(Catalog)(JSON.parse(Buffer.from(await blob(marker)).toString()));

    if (
      !skillName(catalog.name) ||
      catalog.plugins.length > 100 ||
      new Set(catalog.plugins.map((p) => p.name)).size !== catalog.plugins.length
    )
      sourceInvalid("Marketplaces need a portable unique name and at most 100 uniquely named plugins.");
    const plugins: ui.MarketplacePlugin[] = [];
    let total = 0;

    for (const plugin of catalog.plugins) {
      if (!skillName(plugin.name)) sourceInvalid("Invalid plugin name in marketplace.");
      const local = Schema.decodeUnknownOption(Schema.String)(plugin.source);
      const object = Schema.decodeUnknownOption(LocalSource)(plugin.source);
      const path = Option.getOrElse(local, () => (Option.isSome(object) ? object.value.path : ""));

      if (!path.startsWith("./") || path === "./") {
        plugins.push(
          create(ui.MarketplacePluginSchema, {
            artifact: { name: plugin.name },
            unavailableReason:
              "Only repository-local ./plugin paths are supported. External Git/npm/URL bundles need a separately reviewed marketplace.",
          }),
        );
        continue;
      }

      const root = path.slice(2).replace(/\/$/, "");
      checkSkillPath(root);
      const files = [];

      for (const entry of entries.filter((e) => e.path.startsWith(`${root}/`))) {
        total += entry.size;

        if (total > SKILL_TOTAL_BYTES) sourceInvalid("Marketplace plugin artifacts exceed 25 MiB.");
        files.push(gitFile(entry, await blob(entry), root));
      }

      try {
        const artifact = validatePluginFiles(files);

        if (artifact.name !== plugin.name) sourceInvalid("Plugin name differs from its manifest.");

        const harnesses = pluginHarnesses(files);

        plugins.push(create(ui.MarketplacePluginSchema, { artifact, harnesses }));
      } catch {
        plugins.push(
          create(ui.MarketplacePluginSchema, {
            artifact: { name: plugin.name },
            unavailableReason:
              "Plugin manifest is invalid, unsupported, has dependencies, uses reserved cache metadata, exceeds bundle limits, or does not match the catalog name.",
          }),
        );
      }
    }

    return create(ui.EnvironmentMarketplaceSchema, {
      name: catalog.name,
      source: { ...source, commit, autoUpdate: false },
      plugins,
    });
  });
}
