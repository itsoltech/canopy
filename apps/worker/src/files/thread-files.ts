import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FileContentSchema, FileRequest } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { isWithin } from "../git/worktrees.ts";
import { CommandError } from "../runtime/host-types.ts";
import { sniff } from "@canopy/domain";

/** Viewer limit: longer files come back truncated and are read-only in the UI. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

type FileContentInit = MessageInitShape<typeof FileContentSchema>;

const refuse = (code: string, message: string) => new CommandError(code, message, true);

/**
 * The real path of an existing regular file under one of `roots` (the gateway's thread directory)
 * or `extraRoots` (this worker's own thread attachments). `~` expands
 * to the worker's home; symlinks resolve before the check, so a link cannot reach outside the roots.
 */
export function resolveThreadFile(request: FileRequest, extraRoots: readonly string[]): string {
  const raw = request.path.trim();
  const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(1)) : raw;

  if (!expanded || !isAbsolute(expanded))
    throw refuse("FILE_PATH_INVALID", "Use an absolute path or a path inside the thread's folder.");
  let real: string;

  try {
    real = realpathSync(expanded);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR"))
      throw refuse("FILE_NOT_FOUND", "Could not find this file. Check its path, then reload.");
    throw refuse("FILE_READ_FAILED", "Could not read this file. Check its permissions, then reload.");
  }

  if (!statSync(real).isFile()) throw refuse("FILE_NOT_REGULAR", "Only files can be opened, not folders.");

  const roots = [...request.roots, ...extraRoots].flatMap((root) =>
    root && isAbsolute(root) && existsSync(root) ? [realpathSync(root)] : [],
  );

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

/** SHA-256 of the whole file, read in chunks so a large file is never held in memory. */
function hashFile(path: string): string {
  const hash = createHash("sha256");
  readChunks(path, statSync(path).size, (bytes) => hash.update(bytes));

  return hash.digest("hex");
}

function readHead(path: string, length: number): Uint8Array {
  const parts: Uint8Array[] = [];
  readChunks(path, length, (bytes) => parts.push(bytes));

  return Buffer.concat(parts);
}

function metadata(path: string): FileContentInit {
  const stat = statSync(path);

  return { path, size: BigInt(stat.size), sha256: hashFile(path), modifiedMs: BigInt(Math.trunc(stat.mtimeMs)) };
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
  };
}

/** The file on disk still has the content the user read; otherwise their edit would overwrite another change. */
function checkUnchanged(path: string, expected: string): void {
  if (!expected) throw refuse("FILE_HASH_REQUIRED", "Open the file again before changing it.");

  if (hashFile(path) !== expected)
    throw refuse("FILE_CHANGED", "The file changed on disk since you opened it. Reload it to see the changes.");
}

export function writeThreadFile(path: string, content: Uint8Array, expected: string): FileContentInit {
  checkUnchanged(path, expected);
  writeFileSync(path, content);

  return metadata(path);
}

export function deleteThreadFile(path: string, expected: string): void {
  checkUnchanged(path, expected);
  unlinkSync(path);
}
