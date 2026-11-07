import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ImportSnapshotSchema } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { decodeJson, jsonObject } from "../providers/json.ts";

/**
 * Read-only access to CLI files (docs/import.md): fixed-size reads with a plain file descriptor opened read-only,
 * so a scan never changes a file, its times or a lock next to it. Scans read the head and the tail only; imports
 * stream lines up to the size the scan saw.
 *
 * Every read is confined to its CLI home (docs/import.md, "Bezpieczeństwo"): no directory below the root and not the
 * file itself may be a symbolic link, the file is opened without following one, and the open descriptor must still
 * be that file inside the root. A link planted or swapped in at any point reads nothing.
 */

export const PREFIX_BYTES = 64 * 1024;

export type Snapshot = MessageInitShape<typeof ImportSnapshotSchema> & { size: bigint };

/** A file of a CLI home: the home's real path and a path inside it. */
export interface SourceFile {
  readonly root: string;
  readonly path: string;
}

export class ConfinementError extends Error {}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;

/** Directories from the root down to `rel` (inclusive) exist and none is a link. */
function checkDirectories(root: string, rel: string): void {
  if (rel === "" || rel === ".") return;
  let current = root;

  for (const part of rel.split(sep)) {
    current = join(current, part);
    let stat: Stats;

    try {
      stat = lstatSync(current);
    } catch {
      throw new ConfinementError("the source no longer exists");
    }

    if (stat.isSymbolicLink()) throw new ConfinementError("the source path contains a symbolic link");

    if (!stat.isDirectory()) throw new ConfinementError("the source path is not a directory");
  }
}

function relativeInside(file: SourceFile): string {
  const rel = relative(file.root, file.path);

  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ConfinementError("the source path is not inside its directory");

  return rel;
}

/** Where an open descriptor points (Linux); undefined where the system does not tell. */
function descriptorPath(fd: number): string | undefined {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** A regular file inside its root, opened read-only (see the module comment); the caller closes it. */
export function openSource(file: SourceFile): number {
  const rel = relativeInside(file);

  if (rel === "") throw new ConfinementError("the source is not a file");
  checkDirectories(file.root, dirname(rel));
  let before: Stats;

  try {
    before = lstatSync(file.path);
  } catch {
    throw new ConfinementError("the source no longer exists");
  }

  // Only regular files are opened: a FIFO or device at a known name would block or never end.
  if (before.isSymbolicLink()) throw new ConfinementError("the source path contains a symbolic link");

  if (!before.isFile()) throw new ConfinementError("the source is not a regular file");
  let fd: number;

  try {
    // Non-blocking as well: a FIFO swapped in after the check still does not hold the worker.
    fd = openSync(file.path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : "";

    if (code === "ELOOP" || code === "EMLINK") throw new ConfinementError("the source path contains a symbolic link");
    throw new ConfinementError("the source no longer exists");
  }

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev)
      throw new ConfinementError("the source is not a regular file");
    // The path must still name this file through directories without links (no swap since the check).
    checkDirectories(file.root, dirname(rel));
    const now = lstatSync(file.path);

    if (now.isSymbolicLink() || now.ino !== stat.ino || now.dev !== stat.dev)
      throw new ConfinementError("the source changed while it was opened");
    const real = descriptorPath(fd);

    if (real !== undefined && !real.startsWith(file.root + sep))
      throw new ConfinementError("the source path is not inside its directory");

    return fd;
  } catch (cause) {
    closeSync(fd);
    throw cause;
  }
}

/** Size and times of a confined file. */
export function sourceStat(file: SourceFile): Stats {
  const fd = openSource(file);

  try {
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A small confined file as text; undefined when it is missing, refused or larger than `max`. */
export function readSourceText(file: SourceFile, max: number): string | undefined {
  let fd: number;

  try {
    fd = openSource(file);
  } catch {
    return undefined;
  }

  try {
    const size = fstatSync(fd).size;

    if (size > max) return undefined;
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, 0);

    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function sourceExists(file: SourceFile): boolean {
  try {
    closeSync(openSource(file));

    return true;
  } catch {
    return false;
  }
}

export function readRange(file: SourceFile, start: number, length: number): Buffer {
  const fd = openSource(file);

  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);

    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function snapshotOf(file: SourceFile): Snapshot {
  const stat = sourceStat(file);
  const prefix = readRange(file, 0, Math.min(PREFIX_BYTES, stat.size));

  return {
    size: BigInt(stat.size),
    modifiedMs: BigInt(Math.trunc(stat.mtimeMs)),
    prefixSha256: createHash("sha256").update(prefix).digest("hex"),
  };
}

/** Complete lines at the start of a file (a line cut by the limit is left out). */
export function headLines(file: SourceFile, bytes: number, size: number): string[] {
  const text = readRange(file, 0, Math.min(bytes, size)).toString("utf8");
  const lines = text.split("\n");

  if (size > bytes) lines.pop();

  return lines.filter((l) => l.trim());
}

/** Complete lines at the end of a file (the first, cut line is left out unless the read starts at 0). */
export function tailLines(file: SourceFile, bytes: number, size: number): string[] {
  const start = Math.max(0, size - bytes);

  const lines = readRange(file, start, size - start)
    .toString("utf8")
    .split("\n");

  if (start > 0) lines.shift();

  return lines.filter((l) => l.trim());
}

export function parseLine(line: string): JsonObject | undefined {
  try {
    return jsonObject(decodeJson(JSON.parse(line)));
  } catch {
    return undefined;
  }
}

export interface Line {
  /** Byte offset of the line's start. */
  readonly offset: number;
  /** Byte offset right after its newline. */
  readonly end: number;
  readonly text: string;
}

const CHUNK = 4 * 1024 ** 2;

/**
 * Lines between two byte offsets, read in chunks. A line without a newline at `end` is left out (the CLI may still
 * be writing it). A single line longer than `maxLine` is skipped as one unreadable line.
 */
export function* lines(file: SourceFile, start: number, end: number, maxLine = 256 * 1024 ** 2): Generator<Line> {
  const fd = openSource(file);

  try {
    let position = start;
    let pending: Buffer[] = [];
    let pendingStart = start;
    let pendingBytes = 0;

    while (position < end) {
      const buffer = Buffer.alloc(Math.min(CHUNK, end - position));
      const read = readSync(fd, buffer, 0, buffer.length, position);

      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      let from = 0;

      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
        const piece = chunk.subarray(from, at);
        const lineEnd = position + at + 1;
        const tooLong = pendingBytes + piece.length > maxLine;
        const text = tooLong ? "" : Buffer.concat([...pending, piece]).toString("utf8");
        yield { offset: pendingStart, end: lineEnd, text };
        pending = [];
        pendingBytes = 0;
        pendingStart = lineEnd;
        from = at + 1;
      }

      const rest = chunk.subarray(from);

      if (pendingBytes + rest.length <= maxLine) pending.push(Buffer.from(rest));
      pendingBytes += rest.length;
      position += read;
    }
  } finally {
    closeSync(fd);
  }
}

/** Entries of a confined directory (links show as links, never followed), or none when it cannot be read. */
export function directoryEntries(file: SourceFile) {
  try {
    checkDirectories(file.root, relativeInside(file));

    return readdirSync(file.path, { withFileTypes: true });
  } catch {
    return [];
  }
}
