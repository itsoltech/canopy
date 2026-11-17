import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { instructionDirectory } from "./files.ts";
import { installedSkillDigest } from "./installed-manifest.ts";
import { codexPluginVersion } from "./codex-plugin-cache.ts";
import { readSkillTree } from "./skill-files.ts";
import { pluginNamespace } from "./plugin-targets.ts";
import type { ManagedSkill, SkillLedger } from "./skill-ledger.ts";

/** Codex refreshes local marketplaces into the manifest version and removes the previous cache slot. */
export function recoverPluginCaches(ledger: SkillLedger, platform: NodeJS.Platform): void {
  if (ledger.problem) return;
  // Relocation replaces map entries; newly inserted paths belong to the next reconciliation.
  const entries = [...ledger.entries.values()];

  for (const entry of entries) {
    if (
      entry.harness !== "codex" ||
      !entry.owned ||
      basename(dirname(dirname(entry.path))) !== pluginNamespace(entry.skillId, "codex")
    )
      continue;

    try {
      if (readSkillTree(entry.path).exists) continue;
      const candidates = relocatedCaches(entry, platform);

      if (candidates.length !== 1) continue;
      const path = candidates[0]!;
      const targetId = environmentDigest(`skill:${path}`);

      if (!ledger.entries.has(targetId)) ledger.relocate(entry.targetId, { ...entry, path, targetId });
    } catch {
      // Unknown, edited or unreadable paths are left to normal reconciliation; never adopt them.
    }
  }
}

function relocatedCaches(entry: ManagedSkill, platform: NodeJS.Platform): string[] {
  const parent = dirname(entry.path);
  instructionDirectory(parent, false);
  const children = readdirSync(parent, { withFileTypes: true });

  if (children.length > 128) return [];
  const result: string[] = [];

  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    const path = join(parent, child.name);

    try {
      const tree = readSkillTree(path);

      if (
        basename(path) === codexPluginVersion(tree.files) &&
        installedSkillDigest(tree.files, platform) === installedSkillDigest(entry.files, platform) &&
        tree.directories.every((directory) => entry.files.some((file) => file.path.startsWith(`${directory}/`)))
      )
        result.push(path);
    } catch {
      // A sibling without the exact owned manifest cannot be evidence of a native cache move.
    }
  }

  return result;
}
