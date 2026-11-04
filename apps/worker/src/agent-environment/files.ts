import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isUtf8 } from "node:buffer";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { ENVIRONMENT_FILE_BYTES, environmentDigest } from "@canopy/domain/agent-environment";

export class EnvironmentFileError extends Error {}

export interface InstructionFile {
  readonly text: string | undefined;
  readonly mode: number;
  readonly checksum: string;
}

export const fileChecksum = (text: string | undefined): string =>
  environmentDigest(text === undefined ? "absent" : `present:${text}`);

/** No symlinks in the destination chain. A configured shadow home is a directory, never a link into another home. */
export function instructionDirectory(path: string, create: boolean): void {
  if (!isAbsolute(path)) throw new EnvironmentFileError("Instruction homes must be absolute directories.");
  const root = parse(path).root;
  let current = root;

  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;

    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;

      if (!create) return;
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }

    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new EnvironmentFileError(
        "The instruction home contains a symlink or a non-directory. Choose a regular directory.",
      );
  }
}

export function readInstructionFile(path: string, limit = ENVIRONMENT_FILE_BYTES): InstructionFile {
  instructionDirectory(dirname(path), false);
  let descriptor: number;

  try {
    const stat = lstatSync(path);

    if (!stat.isFile() || stat.isSymbolicLink())
      throw new EnvironmentFileError("The instruction file must be a regular file, without symlinks.");
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { text: undefined, mode: 0o600, checksum: fileChecksum(undefined) };
    throw error;
  }

  try {
    const stat = fstatSync(descriptor);

    if (!stat.isFile() || stat.size > limit)
      throw new EnvironmentFileError("The instruction file must be a regular UTF-8 file up to 256 KiB.");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;

    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);

      if (!read) break;
      length += read;
    }

    const bytes = buffer.subarray(0, length);

    if (bytes.length > stat.size)
      throw new EnvironmentFileError("The file changed while reading. Refresh before syncing.");

    if (bytes.length > limit || !isUtf8(bytes))
      throw new EnvironmentFileError("The instruction file must be a regular UTF-8 file up to 256 KiB.");
    const text = bytes.toString("utf8");

    return { text, mode: stat.mode & 0o777, checksum: fileChecksum(text) };
  } finally {
    closeSync(descriptor);
  }
}

/** Same-directory fsync + rename. Failure before rename leaves the old file intact. */
export function replaceInstructionFile(
  path: string,
  expected: InstructionFile,
  text: string,
  limit = ENVIRONMENT_FILE_BYTES,
): void {
  if (Buffer.byteLength(text) > limit)
    throw new EnvironmentFileError("The resulting instruction file would exceed 256 KiB.");
  instructionDirectory(dirname(path), true);
  const temporary = join(dirname(path), `.canopy-instructions-${Bun.randomUUIDv7()}.tmp`);

  try {
    const descriptor = openSync(temporary, "wx", expected.mode);

    try {
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    if (readInstructionFile(path, limit).checksum !== expected.checksum)
      throw new EnvironmentFileError("The file changed after the preview. Refresh before choosing a version.");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Roll back only the bytes this transaction wrote, never a subsequent local edit. */
export function restoreInstructionFile(path: string, previous: InstructionFile, written: string): void {
  const current = readInstructionFile(path);

  if (current.checksum !== fileChecksum(written))
    throw new EnvironmentFileError("The file changed during rollback. Review the local file before syncing.");

  if (previous.text === undefined) rmSync(path);
  else replaceInstructionFile(path, current, previous.text);
}

export function instructionOverrideExists(path: string): boolean {
  return existsSync(join(dirname(path), "AGENTS.override.md"));
}

export const fileProblem = (error: Error): string =>
  error instanceof EnvironmentFileError
    ? error.message
    : "Couldn't update this instruction file. Check its permissions and destination directory.";
