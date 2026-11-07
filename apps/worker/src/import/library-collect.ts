import { join } from "node:path";
import { pluginFacts } from "./library-plugins.ts";
import { itemMaker, readConfig, scanLibrary, sha256, type LibraryItemInit, type MakeItem } from "./library-scan.ts";
import { readCommand, readSkill, shortDescription, skillOrigins, type SkillRead } from "./library-skills.ts";
import type { Masker } from "./masking.ts";
import { directoryEntries } from "./read.ts";
import type { ImportRootPath } from "./source-key.ts";

/**
 * Everything the library scan lists for one root (docs/import.md, "Ustawienia i biblioteka", "Skille i pluginy"):
 * settings and instructions, skills, commands and prompts (as skills, chosen by the owner), marketplaces and
 * plugins. `~/.agents` (the device's shared skills, read by Codex) holds skills only.
 */
export function collectLibrary(root: ImportRootPath, key: Buffer, masker: Masker, agents = false): LibraryItemInit[] {
  const item = itemMaker(root, key, masker);
  const origins = agents ? skillOrigins(readConfig(root, ".skill-lock.json")) : new Map<string, string>();
  const items = agents ? [] : scanLibrary(root, key, masker);
  items.push(...skills(root, masker, item, origins));

  if (agents) return items;
  items.push(...commands(root, masker, item));

  for (const fact of pluginFacts(root.agentCli, (rel) => readConfig(root, rel)))
    items.push(
      item(`${fact.kind === "plugin" ? "plugins" : "marketplaces"}#${fact.name}`, {
        kind: fact.kind,
        name: fact.name,
        source: fact.source,
        version: fact.version,
        detail: fact.source || fact.version,
        digest: sha256(`${fact.source}\0${fact.version}`),
        reason: fact.reason,
      }),
    );

  return items;
}

function secretsWarning(read: SkillRead): string[] {
  return read.secrets > 0
    ? [`Canopy masks ${read.secrets} possible ${read.secrets === 1 ? "secret" : "secrets"} in this skill.`]
    : [];
}

function skills(
  root: ImportRootPath,
  masker: Masker,
  item: MakeItem,
  origins: ReadonlyMap<string, string>,
): LibraryItemInit[] {
  return directoryEntries({ root: root.path, path: join(root.path, "skills") }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) return [];
    const rel = `skills/${entry.name}`;
    const read = readSkill(root, rel, masker);
    const origin = origins.get(entry.name) ?? "";

    return [
      item(rel, {
        kind: "skill",
        name: read.artifact?.name || entry.name,
        detail: shortDescription(read.artifact),
        digest: read.artifact?.checksum ?? "",
        bytes: BigInt(read.files.reduce((sum, f) => sum + f.content.length, 0)),
        files: read.files.length,
        source: origin,
        reason: read.problem,
        warnings: secretsWarning(read),
      }),
    ];
  });
}

const COMMANDS = new Map([
  ["claude", "commands"],
  ["codex", "prompts"],
]);

/** Claude `commands/**.md` and Codex `prompts/*.md`. */
function commands(root: ImportRootPath, masker: Masker, item: MakeItem): LibraryItemInit[] {
  const base = COMMANDS.get(root.agentCli) ?? "";
  const found: string[] = [];

  const walk = (dir: string, depth: number) => {
    for (const entry of directoryEntries({ root: root.path, path: join(root.path, dir) })) {
      if (entry.isDirectory() && root.agentCli === "claude" && depth < 4) walk(`${dir}/${entry.name}`, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(`${dir}/${entry.name}`);
    }
  };

  if (base) walk(base, 0);

  return found.map((rel) => {
    const read = readCommand(root, rel, masker);

    return item(rel, {
      kind: "command",
      name: read.artifact?.name || rel,
      detail: `/${rel.slice(base.length + 1, -3)}`,
      digest: read.artifact?.checksum ?? "",
      bytes: BigInt(read.files.reduce((sum, f) => sum + f.content.length, 0)),
      files: read.files.length,
      reason: read.problem,
      warnings: [...read.warnings, ...secretsWarning(read)],
    });
  });
}
