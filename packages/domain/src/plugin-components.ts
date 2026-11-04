import type { SkillFile } from "@canopy/contracts";
import { Schema } from "effect";

export function pluginHarnesses(files: readonly SkillFile[]): string[] {
  return files.some((f) => f.path === ".codex-plugin/plugin.json")
    ? ["codex", ...(files.some((f) => f.path === ".claude-plugin/plugin.json") ? ["claude"] : [])]
    : ["claude", "codex"];
}

/** Presentation only. Consent always covers the complete bundle, regardless of its component labels. */
export function pluginComponents(files: readonly SkillFile[]): string[] {
  const kinds = new Set<string>();

  for (const file of files) {
    if (/(^|\/)hooks?(\/|\.)/i.test(file.path)) kinds.add("Hooks");

    if (/(^|\/)\.?mcp/i.test(file.path)) kinds.add("MCP servers");

    if (file.executable || /\.(sh|js|ts|py|ps1|mcpb|dxt)$/i.test(file.path)) kinds.add("Executable code");

    if ([".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].includes(file.path)) {
      const manifest = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(new TextDecoder().decode(file.content)));

      if (manifest["hooks"]) kinds.add("Hooks");

      if (manifest["mcpServers"]) kinds.add("MCP servers");

      if (manifest["lspServers"] || manifest["experimental"]) kinds.add("Other executable components");
    }
  }

  return [...kinds];
}
