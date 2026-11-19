import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const samePath = (from: string, to: string) => relative(from, to) === "";
export const statPath = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false });

export function physicalDirectory(path: string): BigIntStats | undefined {
  const stat = statPath(path);

  return stat?.isDirectory() && samePath(path, realpathSync(path)) ? stat : undefined;
}

export function sameEntry(before: BigIntStats, after: BigIntStats | undefined): boolean {
  return after?.dev === before.dev && after.ino === before.ino && after.birthtimeNs === before.birthtimeNs;
}

function unchanged(before: BigIntStats, after: BigIntStats | undefined): boolean {
  return (
    after !== undefined &&
    sameEntry(before, after) &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

interface Directory {
  readonly stat: BigIntStats;
  readonly files: Map<string, BigIntStats>;
  readonly dirs: Map<string, Directory>;
}

/** Take a deletion plan without following links or descending into other devices. */
export async function inspectDirectory(
  path: string,
  stat: BigIntStats,
  verify: (path: string, stat: BigIntStats) => boolean | Promise<boolean>,
  expires: number,
): Promise<Directory | undefined> {
  if (performance.now() > expires || !unchanged(stat, physicalDirectory(path))) return;
  const dirs = new Map<string, Directory>();
  const files = new Map<string, BigIntStats>();

  for (const name of await readdir(path, { withFileTypes: true })) {
    if (name.isSymbolicLink() || performance.now() > expires) return;
    const child = join(path, name.name);
    const info = statPath(child);

    if (!info || info.dev !== stat.dev || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n))) return;

    if (!(await verify(child, info))) return;

    if (info.isDirectory()) {
      const directory = await inspectDirectory(child, info, verify, expires);

      if (!directory) return;
      dirs.set(name.name, directory);
    } else {
      files.set(name.name, info);
    }
  }

  return unchanged(stat, physicalDirectory(path)) ? { stat, dirs, files } : undefined;
}

export function directoryStillMatches(path: string, directory: Directory): boolean {
  if (!unchanged(directory.stat, physicalDirectory(path))) return false;

  for (const [name, stat] of directory.files) {
    if (!unchanged(stat, statPath(join(path, name)))) return false;
  }

  for (const [name, child] of directory.dirs) {
    if (!directoryStillMatches(join(path, name), child)) return false;
  }

  return true;
}

/** Unlink only the inspected leaves. rmdir refuses to discard any entries added since inspection. */
export function removeInspectedDirectory(path: string, directory: Directory): boolean {
  if (!unchanged(directory.stat, physicalDirectory(path))) return false;

  for (const [name, child] of directory.dirs) {
    if (!removeInspectedDirectory(join(path, name), child)) return false;
  }

  for (const [name, stat] of directory.files) {
    const child = join(path, name);

    if (!sameEntry(directory.stat, physicalDirectory(path)) || !unchanged(stat, statPath(child))) return false;
    unlinkSync(child);
  }

  if (!sameEntry(directory.stat, physicalDirectory(path))) return false;
  rmdirSync(path);

  return true;
}

function blobHash(bytes: Buffer, objectId: string): string {
  return createHash(objectId.length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** Verify raw bytes or Git's CRLF checkout conversion without invoking a repository's filters. */
export async function checkoutBlobMatches(path: string, stat: BigIntStats, objectId: string): Promise<boolean> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);

  try {
    if (!unchanged(stat, await handle.stat({ bigint: true }))) return false;

    // Bound memory for the CRLF check. Larger regular files are compared in chunks.
    if (stat.size > 16n * 1024n * 1024n) {
      const hash = createHash(objectId.length === 40 ? "sha1" : "sha256").update(`blob ${stat.size}\0`);

      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);

      return hash.digest("hex") === objectId && unchanged(stat, await handle.stat({ bigint: true }));
    }

    const bytes = await handle.readFile();

    if (!unchanged(stat, await handle.stat({ bigint: true }))) return false;

    if (blobHash(bytes, objectId) === objectId) return true;

    if (!bytes.includes("\r\n") || bytes.includes(0)) return false;
    const crlf = bytes.toString("latin1");
    const lf = crlf.replaceAll("\r\n", "\n");

    return lf.replaceAll("\n", "\r\n") === crlf && blobHash(Buffer.from(lf, "latin1"), objectId) === objectId;
  } finally {
    await handle.close();
  }
}
