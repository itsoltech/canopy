import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { SkillFileSchema, type SkillFile } from "@canopy/contracts";
import {
  checkSkillPath,
  skillDigest,
  skillManifestDigest,
  SKILL_FILE_BYTES,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
} from "@canopy/domain/skill-artifact";
import { instructionDirectory } from "./files.ts";

export interface SkillTree {
  readonly exists: boolean;
  readonly files: SkillFile[];
  readonly checksum: string;
  readonly directories: string[];
}

export const absentSkillChecksum = skillDigest(Buffer.from("absent"));

/** A bounded snapshot of regular files. Reject links in every component, including dangling links. */
export function readSkillTree(path: string): SkillTree {
  instructionDirectory(dirname(path), false);

  try {
    const stat = lstatSync(path);

    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Skill destinations must be regular directories without symlinks.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { exists: false, files: [], directories: [], checksum: absentSkillChecksum };
    throw error;
  }

  const files: SkillFile[] = [];
  const directories: string[] = [];
  let total = 0;
  let entries = 0;

  const walk = (directory: string, prefix: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      entries++;

      if (entries > SKILL_FILE_COUNT * 2) throw new Error("Too many entries in the local skill folder.");
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      checkSkillPath(relative);
      const absolute = join(path, relative);
      const stat = lstatSync(absolute);

      if (stat.isSymbolicLink()) throw new Error("Symlinks inside a skill are not allowed.");

      if (stat.isDirectory()) {
        directories.push(relative);
        walk(absolute, relative);
        continue;
      }

      if (!stat.isFile() || stat.size > SKILL_FILE_BYTES || files.length >= SKILL_FILE_COUNT)
        throw new Error("Local skill contains a special file or exceeds the file limits.");

      const descriptor = openSync(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );

      try {
        const opened = fstatSync(descriptor);

        if (!opened.isFile() || opened.size > SKILL_FILE_BYTES)
          throw new Error("Local skill file changed during reading.");
        // Size is checked before allocation; the bounded read detects concurrent file growth.
        const content = Buffer.alloc(SKILL_FILE_BYTES + 1);
        const bytes = readFileBounded(descriptor, content);
        total += bytes.length;

        if (bytes.length > SKILL_FILE_BYTES || total > SKILL_TOTAL_BYTES)
          throw new Error("Local skill exceeds 25 MiB.");
        files.push(
          create(SkillFileSchema, {
            path: relative,
            content: bytes,
            checksum: skillDigest(bytes),
            executable: Boolean(opened.mode & 0o111),
          }),
        );
      } finally {
        closeSync(descriptor);
      }
    }
  };

  walk(path, "");

  return {
    exists: true,
    files,
    directories,
    checksum: skillDigest(Buffer.from(JSON.stringify([skillManifestDigest(files), directories.sort()]))),
  };
}

function readFileBounded(descriptor: number, buffer: Buffer): Buffer {
  let length = 0;

  while (length < buffer.length) {
    const read = readSync(descriptor, buffer, length, buffer.length - length, null);

    if (!read) break;
    length += read;
  }

  return buffer.subarray(0, length);
}

export function writeSkillTree(path: string, files: readonly SkillFile[], directories: readonly string[] = []): void {
  instructionDirectory(path, true);

  for (const directory of directories) {
    checkSkillPath(directory);
    instructionDirectory(join(path, directory), true);
  }

  for (const file of files) {
    checkSkillPath(file.path);
    const destination = join(path, file.path);
    instructionDirectory(dirname(destination), true);
    const descriptor = openSync(destination, "wx", file.executable ? 0o700 : 0o600);

    try {
      writeFileSync(descriptor, file.content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
