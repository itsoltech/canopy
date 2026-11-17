import { Schema } from "effect";
import { join } from "node:path";
import { installedSkillDigest } from "./installed-manifest.ts";
import { assertCodexPluginSlot } from "./codex-plugin-cache.ts";
import { readInstructionFile } from "./files.ts";
import { readSkillTree } from "./skill-files.ts";
import { pluginIndexPath, observedPluginConfig } from "./plugin-config.ts";
import { isClaudeCacheMarker } from "./claude-cache.ts";

const Index = Schema.Struct({
  plugins: Schema.Record(Schema.String, Schema.Struct({ path: Schema.String, checksum: Schema.String })),
  status: Schema.Record(Schema.String, Schema.Struct({ blocked: Schema.Boolean })),
  checks: Schema.Record(
    Schema.String,
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["toml", "json"]),
      fields: Schema.Array(Schema.String),
      checksum: Schema.String,
    }),
  ),
});

/** No user settings are enabled for Claude. Only fully reconciled, exact approved bundles may load. */
export function managedPlugins(
  home: string,
  harness: string,
  platform: NodeJS.Platform = process.platform,
): { type: "local"; path: string }[] {
  const file = readInstructionFile(pluginIndexPath(home, harness));

  if (!file.text) {
    if (harness === "codex" && readInstructionFile(join(home, "config.toml")).text?.includes("# canopy:plugins:begin"))
      throw new Error(
        "Managed plugin activation receipt is missing. Refresh the environment before starting a session.",
      );

    return [];
  }

  const index = Schema.decodeUnknownSync(Index)(JSON.parse(file.text));

  if (Object.values(index.status).some((s) => s.blocked))
    throw new Error("Managed plugins need attention in Settings → Agent environment before starting a new session.");

  if (Object.values(index.checks).some((check) => observedPluginConfig(check) !== check.checksum))
    throw new Error("Managed plugin activation changed locally. Resolve its drift before starting a new session.");

  return Object.values(index.plugins).map((plugin) => {
    if (harness === "codex") assertCodexPluginSlot(plugin.path);
    const tree = readSkillTree(plugin.path);

    const files = harness === "claude" ? tree.files.filter((f) => !isClaudeCacheMarker(f.path)) : tree.files;

    if (!tree.exists || installedSkillDigest(files, platform) !== plugin.checksum)
      throw new Error(
        "A managed plugin changed locally. Resolve its drift in Settings → Agent environment before starting a session.",
      );

    return { type: "local", path: plugin.path };
  });
}
