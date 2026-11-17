import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { SkillFile } from "@canopy/contracts";
import { Schema } from "effect";
import { instructionDirectory } from "./files.ts";
import { readSkillTree } from "./skill-files.ts";

const Manifest = Schema.Struct({ version: Schema.optionalKey(Schema.NullOr(Schema.String)) });

/** Match Codex's manifest precedence and native cache version, without trusting path components. */
export function codexPluginVersion(files: readonly SkillFile[]): string {
  const manifest =
    files.find((file) => file.path === ".codex-plugin/plugin.json") ??
    files.find((file) => file.path === ".claude-plugin/plugin.json");

  if (!manifest) throw new Error("The plugin has no manifest. Add a plugin.json manifest before syncing.");

  const decoded = Schema.decodeUnknownSync(Manifest)(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.content)),
  );

  const version = decoded.version?.trim() ?? "local";

  if (!/^[A-Za-z0-9._+-]+$/.test(version) || version === "." || version === "..")
    throw new Error("The plugin version can't name a cache folder. Use a nonempty version without path separators.");

  return version;
}

/** Codex selects an active sibling itself; an unreviewed entry must never outrank our approved slot. */
export function assertCodexPluginSlot(path: string): void {
  const parent = dirname(path);
  instructionDirectory(parent, false);
  readSkillTree(path);
  let entries: string[];

  try {
    entries = readdirSync(parent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  if (entries.some((entry) => entry !== basename(path)))
    throw new Error("The Codex plugin cache contains another entry. Move the extra entry before syncing this plugin.");
}
