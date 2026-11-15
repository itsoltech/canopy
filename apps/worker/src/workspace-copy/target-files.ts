import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceCopyChunk, WorkspaceCopyEntry } from "@canopy/contracts";
import {
  COPY_FRAME_BYTES,
  COPY_MAX_BYTES,
  COPY_MAX_ENTRIES,
  COPY_MAX_FILE_BYTES,
  copyGenerated,
  copyTotals,
} from "@canopy/domain/workspace-copy";
import { copyError, checkedPath, checkedParent, within } from "./safety.ts";
import { mapLimit } from "./limit.ts";

const SYNC_CONCURRENCY = 32;
const HASH_CONCURRENCY = 8;

/** A complete staged file: its path and SHA-256 (of the link text for symlinks). */
export type Staged = { path: string; size: bigint; sha256: string };

/**
 * Files an interrupted transfer left in its private staging directory. Anything not selected now, of another
 * type or of another size is removed; the rest is hashed so the gateway can confirm it with the source.
 */
export async function stagedFiles(stage: string, entries: ReadonlyMap<string, WorkspaceCopyEntry>) {
  const files: string[] = [];
  const directories: string[] = [];
  await walk(stage, stage, files, directories);
  const kept: string[] = [];

  for (const path of files) {
    const entry = entries.get(path);
    const info = await lstat(join(stage, path));
    const fits = entry && !entry.directory && (entry.symlink ? info.isSymbolicLink() : info.isFile());

    if (fits && (entry.symlink || BigInt(info.size) === entry.size)) kept.push(path);
    else await rm(join(stage, path), { force: true });
  }

  for (const path of directories.sort((a, b) => b.length - a.length))
    if (!entries.get(path)?.directory) await rmdir(join(stage, path)).catch(() => {});

  return mapLimit(kept, HASH_CONCURRENCY, async (path): Promise<Staged> => {
    // SAFETY: `kept` holds only paths found in `entries` above.
    const entry = entries.get(path)!;
    const full = join(stage, path);
    const sha256 = entry.symlink
      ? createHash("sha256")
          .update(await readlink(full))
          .digest("hex")
      : await hashLocal(full);

    return { path, size: entry.size, sha256 };
  });
}

async function walk(root: string, directory: string, files: string[], directories: string[]) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, item.name);
    const path = relative(root, full).split(sep).join("/");

    if (item.isDirectory()) {
      directories.push(path);
      await walk(root, full, files, directories);
    } else files.push(path);
  }
}

async function hashLocal(full: string) {
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");

  try {
    const buffer = Buffer.allocUnsafe(COPY_FRAME_BYTES);

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

      if (!bytesRead) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/** Writes one piece; the first piece replaces whatever an earlier attempt left at that path. */
export async function writePiece(
  stage: string,
  entry: WorkspaceCopyEntry,
  chunk: WorkspaceCopyChunk,
  dirs: Set<string>,
) {
  const full = checkedPath(stage, entry.path);
  const parent = dirname(full);

  if (!dirs.has(parent)) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await checkedParent(stage, full);
    dirs.add(parent);
  }

  if (entry.symlink) {
    if (!chunk.last || chunk.offset !== 0n || Buffer.from(chunk.data).toString() !== entry.symlink)
      throw copyError("Invalid symlink payload.");
    await rm(full, { force: true });

    return;
  }

  const first = chunk.offset === 0n;
  const handle = await open(
    full,
    constants.O_WRONLY | constants.O_NOFOLLOW | (first ? constants.O_CREAT | constants.O_TRUNC : 0),
    0o600,
  );

  try {
    let written = 0;
    const offset = Number(chunk.offset);

    while (written < chunk.data.length) {
      const result = await handle.write(chunk.data, written, chunk.data.length - written, offset + written);

      if (!result.bytesWritten) throw copyError("The target disk could not accept the file.");
      written += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

/** Makes a verified file final: the mode of the source, or the symlink itself. */
export async function settle(stage: string, entry: WorkspaceCopyEntry) {
  const full = checkedPath(stage, entry.path);

  if (entry.symlink) await symlink(entry.symlink, full);
  else await chmod(full, entry.mode & 0o777);
}

/** One durable pass before publishing, instead of an fsync on the critical path of every file. */
export async function syncFiles(stage: string, entries: Iterable<WorkspaceCopyEntry>) {
  const files = [...entries].filter((e) => !e.directory && !e.symlink);
  await mapLimit(files, SYNC_CONCURRENCY, async (entry) => {
    const handle = await open(checkedPath(stage, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/** Best effort: directories cannot be opened for syncing on every platform. */
export async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY).catch(() => undefined);

  try {
    await handle?.sync();
  } catch {
    /* Not supported for directories here; the rename itself is atomic. */
  } finally {
    await handle?.close();
  }
}

export function validateEntries(entries: readonly WorkspaceCopyEntry[], bytes: bigint) {
  if (entries.length > COPY_MAX_ENTRIES || bytes > COPY_MAX_BYTES || copyTotals(entries).bytes !== bytes)
    throw copyError("The selection exceeds the 20 GB copy limit.");
  const paths = new Set<string>();

  for (const e of entries) {
    checkedPath("/", e.path);

    if (e.ignored && copyGenerated(e.directory || e.symlink ? e.path : dirname(e.path)))
      throw copyError("Dependencies and build output cannot be copied.");

    if (e.blocked || e.size > COPY_MAX_FILE_BYTES)
      throw copyError("A selected file cannot be copied (8 GB per-file limit).");
    const key = e.path.toLowerCase();

    if (paths.has(key)) throw copyError("Two selected paths differ only in letter case.");
    paths.add(key);

    if (
      e.symlink &&
      (isAbsolute(e.symlink) ||
        e.symlink.includes("\\") ||
        !within("/copy", resolve("/copy", dirname(e.path), e.symlink)))
    )
      throw copyError("A symlink points outside the repository.");
  }

  const links = new Set(entries.filter((e) => e.symlink).map((e) => e.path));

  for (const e of entries) {
    const parts = e.path.split("/");

    for (let i = 1; i < parts.length; i++)
      if (links.has(parts.slice(0, i).join("/"))) throw copyError("A selected file is inside a symlink.");
  }

  if (!entries.some((e) => e.path === ".git/HEAD") || !entries.some((e) => e.path === ".git/config"))
    throw copyError("Include the Git metadata to create a usable checkout.");
}
