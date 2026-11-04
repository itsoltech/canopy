import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { create } from "@bufbuild/protobuf";
import { SkillArtifactSchema, SkillFileSchema, type SkillFile } from "@canopy/contracts";
import { Schema } from "effect";

export const SKILL_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const SKILL_TOTAL_BYTES = 25 * 1024 * 1024;
export const SKILL_FILE_BYTES = 1024 * 1024;
export const SKILL_FILE_COUNT = 1000;
export const skillDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const skillName = (name: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;

export function checkSkillPath(path: string): void {
  if (
    !path ||
    path.length > 240 ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          !/^[a-zA-Z0-9_. -]+$/.test(part) ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Skill paths must be relative, portable paths without traversal or reserved names.");
}

/** Canonical manifest includes content digests and executable bits, independent of archive ordering. */
export function skillManifestDigest(files: readonly SkillFile[]): string {
  return skillDigest(
    Buffer.from(
      JSON.stringify(
        [...files]
          .sort((a, b) => a.path.localeCompare(b.path, "en"))
          .map((file) => [file.path, file.checksum, file.executable]),
      ),
    ),
  );
}

const Metadata = Schema.Struct({ name: Schema.String, description: Schema.String });

export function validateArtifactFiles(input: readonly SkillFile[]) {
  if (!input.length || input.length > SKILL_FILE_COUNT) throw new Error("Upload between 1 and 1000 skill files.");
  const paths = new Set<string>();
  const spelling = new Map<string, string>();
  let total = 0;

  const files = input.map((file) => {
    checkSkillPath(file.path);
    const key = file.path.toLowerCase();

    const parts = file.path.split("/");

    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const alias = spelling.get(prefix.toLowerCase());

      if (alias && alias !== prefix) throw new Error("Duplicate or case-colliding skill paths are not allowed.");
      spelling.set(prefix.toLowerCase(), prefix);
    }

    if (paths.has(key)) throw new Error("Duplicate or case-colliding skill paths are not allowed.");
    paths.add(key);
    total += file.content.length;

    if (file.content.length > SKILL_FILE_BYTES || total > SKILL_TOTAL_BYTES)
      throw new Error("Skills are limited to 1 MiB per file and 25 MiB in total.");

    return create(SkillFileSchema, { ...file, checksum: skillDigest(file.content) });
  });

  for (const path of paths) {
    const parts = path.split("/");

    while (parts.length > 1) {
      parts.pop();

      if (paths.has(parts.join("/"))) throw new Error("A skill file cannot also be a directory.");
    }
  }

  return files;
}

export function validateSkillFiles(input: readonly SkillFile[]) {
  const files = validateArtifactFiles(input);
  const entry = files.find((file) => file.path === "SKILL.md");

  if (!entry || !isUtf8(entry.content)) throw new Error("The skill root must contain a UTF-8 SKILL.md.");

  const frontmatter = Buffer.from(entry.content)
    .toString("utf8")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!frontmatter) throw new Error("SKILL.md must start with YAML name and description frontmatter.");
  const metadata = Schema.decodeUnknownSync(Metadata)(Bun.YAML.parse(frontmatter[1]!));

  if (!skillName(metadata.name) || !metadata.description.trim() || metadata.description.length > 1024)
    throw new Error("Use a lowercase hyphenated skill name (64 characters) and a description (1024 characters).");
  checkSkillPath(metadata.name);

  return create(SkillArtifactSchema, { ...metadata, files, checksum: skillManifestDigest(files) });
}
