import { isUtf8 } from "node:buffer";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { SkillFileSchema, type SkillArtifact, type SkillFile } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import {
  SKILL_FILE_BYTES,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
  skillName,
  validateSkillFiles,
} from "@canopy/domain/skill-artifact";
import { isJsonObject, jsonString } from "../providers/json.ts";
import { maskText, type Masker } from "./masking.ts";
import { directoryEntries, readRange, readSourceText, sourceStat, type SourceFile } from "./read.ts";
import type { ImportRootPath } from "./source-key.ts";

/**
 * Skills of the CLI homes as library skills (docs/import.md, "Skille i pluginy"): every skill directory is read
 * through the confined reader (regular files only, no links), masked like any imported text, and validated with the
 * library's own rules, so the scan's digest is the checksum the library will store. Claude commands and Codex
 * prompts become skills on request: one generated SKILL.md each.
 */

export interface SkillRead {
  readonly files: SkillFile[];
  readonly artifact?: SkillArtifact;
  readonly problem: string;
  readonly secrets: number;
}

const LIMITS = "The skill is larger than the limits: 1,000 files, 1 MiB per file, 25 MiB in total.";

/** UTF-8 alone also accepts BOM-less UTF-16 ASCII and binary with NULs. */
function maskableText(raw: Buffer): boolean {
  return isUtf8(raw) && !raw.some((byte) => (byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127);
}

/** A skill directory `rel` of the root, masked and validated. */
export function readSkill(root: ImportRootPath, rel: string, masker: Masker): SkillRead {
  const files: SkillFile[] = [];
  let total = 0;
  let secrets = 0;
  let problem = "";

  const walk = (dir: string, prefix: string) => {
    for (const entry of directoryEntries({ root: root.path, path: join(root.path, dir) })) {
      if (problem) return;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Links and special files are never read; a skill holds regular files and directories.
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) {
        const file: SourceFile = { root: root.path, path: join(root.path, dir, entry.name) };
        const stat = sourceStat(file);
        total += stat.size;

        if (files.length >= SKILL_FILE_COUNT || stat.size > SKILL_FILE_BYTES || total > SKILL_TOTAL_BYTES) {
          problem = LIMITS;

          return;
        }

        const raw = readRange(file, 0, stat.size);

        // Only text Canopy can mask leaves the worker: a file in another encoding or a binary one could carry a
        // credential the masking cannot see, so the skill is not imported (fail closed).
        if (!maskableText(raw)) {
          problem = `${path} is not UTF-8 text, so Canopy can't check it for secrets. Add the skill in Agent environment.`;

          return;
        }

        const content = Buffer.from(maskText(raw.toString("utf8"), masker, () => (secrets += 1)));
        files.push(create(SkillFileSchema, { path, content, executable: (stat.mode & 0o111) !== 0 }));
      }
    }
  };

  try {
    walk(rel, "");
  } catch (cause) {
    return { files: [], problem: cause instanceof Error ? cause.message : "The skill can't be read.", secrets };
  }

  if (problem) return { files: [], problem, secrets };
  // A stable order whatever the directory listing gives.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return validated(files, secrets);
}

function validated(files: SkillFile[], secrets: number): SkillRead {
  try {
    return { files, artifact: validateSkillFiles(files), problem: "", secrets };
  } catch (cause) {
    return { files: [], problem: cause instanceof Error ? cause.message : "The skill is not valid.", secrets };
  }
}

/** YAML frontmatter at the start of a Markdown file: its simple `key: value` lines, and the body after it. */
interface Frontmatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
}

function frontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fields = new Map<string, string>();

  if (!match) return { fields, body: text };

  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);

    if (pair) fields.set(pair[1]!, pair[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }

  return { fields, body: text.slice(match[0].length) };
}

/** A command file's skill name: its path in lowercase words joined by hyphens (`git/commit.md` → `git-commit`). */
export function commandSkillName(rel: string): string {
  return rel
    .replace(/^(?:commands|prompts)\//, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/**
 * A Claude command (`commands/**.md`) or Codex prompt (`prompts/*.md`) as a skill: SKILL.md with the command's
 * description (or its first line) and its text. A command that reads `$ARGUMENTS` gets them as plain text now.
 */
export function readCommand(root: ImportRootPath, rel: string, masker: Masker): SkillRead & { warnings: string[] } {
  const text = readSourceText({ root: root.path, path: join(root.path, rel) }, SKILL_FILE_BYTES);
  const name = commandSkillName(rel);

  if (text === undefined) return { files: [], problem: "The file can't be read.", secrets: 0, warnings: [] };

  if (!maskableText(Buffer.from(text)))
    return {
      files: [],
      problem: `${rel} is not UTF-8 text. Add the skill in Agent environment.`,
      secrets: 0,
      warnings: [],
    };

  if (!skillName(name)) return { files: [], problem: "Its name can't be a skill name.", secrets: 0, warnings: [] };
  let found = 0;
  const masked = maskText(text, masker, () => (found += 1));
  const { fields, body } = frontmatter(masked);

  const firstLine =
    body
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";

  const kind = rel.startsWith("prompts/") ? "prompt" : "command";
  const description = (fields.get("description") || firstLine || `Imported ${kind} /${name}`).slice(0, 1000);
  const warnings = /\$ARGUMENTS|\$[1-9]/.test(body) ? ["Uses $ARGUMENTS; a skill gets them from the request."] : [];

  const skill = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trimStart()}`;
  const files = [create(SkillFileSchema, { path: "SKILL.md", content: Buffer.from(skill) })];

  return { ...validated(files, found), warnings };
}

/** The first line of a skill's description, for the list. */
export function shortDescription(artifact: SkillArtifact | undefined): string {
  const text = artifact?.description.replace(/\s+/g, " ").trim() ?? "";

  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** `.skill-lock.json` of `~/.agents`: where each skill came from (a repository and path, no commit). */
export function skillOrigins(lock: JsonObject | undefined): Map<string, string> {
  const skills = lock?.["skills"];
  const origins = new Map<string, string>();

  if (!isJsonObject(skills)) return origins;

  for (const [name, entry] of Object.entries(skills)) {
    if (!isJsonObject(entry)) continue;
    const source = jsonString(entry["sourceUrl"]) || jsonString(entry["source"]);

    if (source) origins.set(name, source);
  }

  return origins;
}
