import { createHash } from "node:crypto";
import { accessSync, constants, closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FileContentSchema, FileRequest } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { isWithin } from "../git/worktrees.ts";
import { CommandError } from "../runtime/host-types.ts";
import { sniff } from "@canopy/domain";
import { fileChanged, type FileMutation } from "./file-mutation.ts";
import { openFileMutation } from "./file-mutation-open.ts";

/** Viewer limit: longer files come back truncated and are read-only in the UI. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

type FileContentInit = MessageInitShape<typeof FileContentSchema>;

const refuse = (code: string, message: string) => new CommandError(code, message, true);

export function expandFileHome(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(1)) : path;
}

/** Resolve an existing regular file using the worker account's filesystem permissions. */
export function resolveReadableFile(path: string): string {
  const expanded = expandFileHome(path.trim());

  if (!expanded || !isAbsolute(expanded))
    throw refuse("FILE_PATH_INVALID", "Use an absolute path or a path inside the thread's folder.");
  let real: string;

  try {
    real = realpathSync.native(expanded);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR"))
      throw refuse("FILE_NOT_FOUND", "Could not find this file. Check its path, then reload.");
    throw refuse("FILE_READ_FAILED", "Could not read this file. Check its permissions, then reload.");
  }

  if (!statSync(real).isFile()) throw refuse("FILE_NOT_REGULAR", "Only files can be opened, not folders.");

  try {
    accessSync(real, constants.R_OK);
  } catch {
    throw refuse("FILE_READ_FAILED", "Could not read this file. Check its permissions, then reload.");
  }

  return real;
}

/** Canonical roots; the same list that authorises a path also bounds the verified mutation of it. */
export function threadFileRoots(request: FileRequest, extraRoots: readonly string[]): string[] {
  return [...request.roots, ...extraRoots].flatMap((root) =>
    root && isAbsolute(root) && existsSync(root) ? [realpathSync.native(root)] : [],
  );
}

/** Mutations and native app actions remain confined after resolving symlinks. */
export function resolveThreadFile(request: FileRequest, extraRoots: readonly string[]): string {
  const real = resolveReadableFile(request.path);
  const roots = threadFileRoots(request, extraRoots);

  if (!roots.some((root) => isWithin(root, real)))
    throw refuse("FILE_OUTSIDE_ROOTS", "This file is outside the thread's folders, so Canopy cannot open it.");

  return real;
}

/** Reads `length` bytes from the start (fewer at the end of the file) and passes each chunk to `chunk`. */
function readChunks(path: string, length: number, chunk: (bytes: Uint8Array) => void): void {
  const buffer = new Uint8Array(1024 * 1024);
  const fd = openSync(path, "r");

  try {
    for (let offset = 0; offset < length;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);

      if (read === 0) break;
      chunk(buffer.slice(0, read));
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
}

function readHead(path: string, length: number): Uint8Array {
  const parts: Uint8Array[] = [];
  readChunks(path, length, (bytes) => parts.push(bytes));

  return Buffer.concat(parts);
}

/** Validate the complete bounded preview, including bytes beyond the MIME sniffer's sample. */
function isUtf8(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return true;
  } catch {
    return false;
  }
}

/** A partial read can end inside a multi-byte character: drop the incomplete tail before the UTF-8 check. */
function completeUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  let back = 0;

  while (end > 0 && back < 4 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) {
    end--;
    back++;
  }

  const lead = bytes[end - 1] ?? 0;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

  return end > 0 && width > back + 1 ? bytes.subarray(0, end - 1) : bytes;
}

function readOnly(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);

    return false;
  } catch {
    return true;
  }
}

export function readThreadFile(path: string, maxBytes: number, includeBinary = false): FileContentInit {
  const limit = Math.min(maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const truncated = statSync(path).size > limit;
  const head = readHead(path, limit);
  const complete = truncated ? completeUtf8(head) : head;
  const detected = sniff(complete, path);
  const text = detected.text && isUtf8(complete);
  const shown = text ? complete : head;

  // A preview never hashes an unbounded file. A truncated read cannot authorize edits or deletion.
  const stat = statSync(path);

  return {
    path,
    size: BigInt(stat.size),
    modifiedMs: BigInt(Math.trunc(stat.mtimeMs)),
    sha256: truncated ? "" : createHash("sha256").update(head).digest("hex"),
    content: text || includeBinary ? shown : new Uint8Array(),
    mimeType: detected.mimeType,
    binary: !text,
    truncated,
    readOnly: readOnly(path),
  };
}

/** Hash of the whole file through the pinned handle, in chunks so a large file is never held in memory. */
function hashMutation(file: FileMutation): string {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(1024 * 1024);

  for (let offset = 0; ;) {
    const read = file.read(buffer, offset);

    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    offset += read;
  }

  return hash.digest("hex");
}

/** The file on disk still has the content the user read; otherwise their edit would overwrite another change. */
function checkUnchanged(file: FileMutation, expected: string): void {
  if (!expected) throw refuse("FILE_HASH_REQUIRED", "Open the file again before changing it.");

  if (hashMutation(file) !== expected) throw fileChanged();
  file.verify();
}

/** Write and delete act on the file that was opened and checked, not on a pathname resolved again. */
export function writeThreadFile(
  path: string,
  content: Uint8Array,
  expected: string,
  roots: readonly string[],
): FileContentInit {
  const file = openFileMutation(path, true, roots);

  try {
    checkUnchanged(file, expected);
    file.write(content);
    const stat = file.stat();

    return {
      path,
      size: BigInt(stat.size),
      sha256: createHash("sha256").update(content).digest("hex"),
      modifiedMs: stat.modified,
    };
  } finally {
    file.close();
  }
}

export function deleteThreadFile(path: string, expected: string, roots: readonly string[]): void {
  const file = openFileMutation(path, false, roots);

  try {
    checkUnchanged(file, expected);
    file.delete();
  } finally {
    file.close();
  }
}
