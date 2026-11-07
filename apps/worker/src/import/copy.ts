import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Option, Schema } from "effect";

/**
 * Native copies in a private home (docs/import.md, "Kontynuacja"), written and removed by identity, never through
 * a link:
 *
 * - a copy is first written in full to a staging directory of its own inside the home (new files, `O_EXCL |
 *   O_NOFOLLOW`), so a source that cannot be masked fails before anything is in place;
 * - then the directories it needs are made, the manifest is written with the identity (device and inode) of the
 *   home, of each directory it made and of each staged file as `pending`, and only then are the files renamed
 *   into place (a rename keeps the inode); the manifest becomes final after the last rename. A failure rolls back
 *   what this copy published; an interrupted publication stays recorded, so a retry can finish it;
 * - Remove starts from the private home the worker expects (never a path from the manifest), requires it to be the
 *   recorded directory, walks down through real directories only, and deletes a file or directory only when its
 *   identity is the recorded one. A swapped home, a linked ancestor or a file someone put there instead stays.
 *
 * Node has no `unlinkat`: each identity is checked right before its unlink or rename, which leaves a window of a
 * few system calls for a concurrent swap inside a home only Canopy writes to.
 */

export class CopyError extends Error {}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
const Entry = Schema.Struct({ rel: Schema.String, dev: Schema.String, ino: Schema.String });

const Manifest = Schema.Struct({
  home: Identity,
  files: Schema.Array(Entry),
  dirs: Schema.Array(Entry),
  size: Schema.String,
  prefixSha256: Schema.String,
  /**
   * A publication in progress: the files it is moving into place, written before the first rename. A worker that
   * stops halfway leaves both sets recorded; the next attempt or Remove knows every file as Canopy's own.
   */
  pending: Schema.optional(
    Schema.Struct({ files: Schema.Array(Entry), size: Schema.String, prefixSha256: Schema.String }),
  ),
});

type Manifest = typeof Manifest.Type;

type Entry = typeof Entry.Type;

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

const identity = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino) });

const same = (stat: BigIntStats, entry: { dev: string; ino: string }) =>
  String(stat.dev) === entry.dev && String(stat.ino) === entry.ino;

function lstat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
}

/** A relative path that stays inside its base. */
/** A relative path of plain names only (no `.`, `..` or empty part anywhere) that resolves inside its base. */
function inside(rel: string): boolean {
  if (!rel || isAbsolute(rel) || rel.split(sep).some((part) => part === "" || part === "." || part === ".."))
    return false;
  const base = resolve("/base");

  return resolve(base, rel).startsWith(base + sep);
}

/** The home as a real directory (not a link); created when missing. */
function homeDirectory(home: string): BigIntStats {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = lstat(home);

  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new CopyError("the private home is not a directory");

  return stat;
}

/** `rel` below `home` through real directories only: its stat when it is of the expected kind. */
function walk(home: string, rel: string, last: "file" | "directory"): BigIntStats | undefined {
  if (!inside(rel)) return undefined;
  let current = home;
  const parts = rel.split(sep);

  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstat(current);

    if (!stat || stat.isSymbolicLink()) return undefined;

    if (index === parts.length - 1) return (last === "file" ? stat.isFile() : stat.isDirectory()) ? stat : undefined;

    if (!stat.isDirectory()) return undefined;
  }

  return undefined;
}

/** One native copy: `write` stages files, `commit` publishes them; staging never outlives the copy. */
export class PrivateCopy {
  readonly home: string;
  readonly #homeId: BigIntStats;
  readonly #staging: string;
  readonly #staged = new Map<string, string>();
  readonly #previous: Manifest | undefined;

  constructor(
    home: string,
    readonly manifestPath: string,
  ) {
    this.#homeId = homeDirectory(home);
    this.home = home;
    const previous = readManifest(manifestPath);
    // A manifest of another directory (the home was replaced) is not this home's.
    this.#previous = previous && same(this.#homeId, previous.home) ? previous : undefined;
    this.#staging = join(home, `.canopy-import-${randomUUID()}`);
    mkdirSync(this.#staging, { mode: 0o700 });
  }

  /** The copy recorded for this session, made from the same snapshot and still in place. */
  sameAs(snapshot: { size: string; prefixSha256: string }): boolean {
    const previous = this.#previous;

    return (
      previous !== undefined &&
      previous.pending === undefined &&
      previous.size === snapshot.size &&
      previous.prefixSha256 === snapshot.prefixSha256 &&
      previous.files.every((f) => {
        const stat = walk(this.home, f.rel, "file");

        return stat !== undefined && same(stat, f);
      })
    );
  }

  /** Writes `chunks` as `rel` (relative to the home) into the staging directory. */
  write(rel: string, chunks: Iterable<string | Uint8Array>): void {
    if (!inside(rel) || this.#staged.has(rel)) throw new CopyError("the copy's path is not valid");
    const staged = join(this.#staging, String(this.#staged.size));
    const fd = openSync(staged, CREATE, 0o600);

    try {
      for (const chunk of chunks) writeSync(fd, Buffer.from(chunk));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    this.#staged.set(rel, staged);
  }

  /**
   * Publishes the staged files. An existing file at a target must be one an earlier copy of this session wrote (its
   * recorded identity); anything else stops the copy before a file moves.
   */
  commit(snapshot: { size: string; prefixSha256: string }): void {
    // Files of earlier copies, finished or interrupted: Canopy's own by their identity.
    const own = [...(this.#previous?.files ?? []), ...(this.#previous?.pending?.files ?? [])];
    const dirs: Entry[] = [...(this.#previous?.dirs ?? [])];
    const files: Entry[] = [];
    const moved: Entry[] = [];

    try {
      for (const [rel, staged] of this.#staged) {
        this.#directories(dirname(rel), dirs);
        const target = lstat(join(this.home, rel));

        if (target) {
          if (target.isSymbolicLink() || !target.isFile())
            throw new CopyError("the private home holds a link or a directory where the copy belongs");

          if (!own.some((entry) => entry.rel === rel && same(target, entry)))
            throw new CopyError("Canopy already has a different copy of this session");
        }

        files.push({ rel, ...identity(lstatSync(staged, { bigint: true })) });
      }

      const pending = [...files];

      // Earlier files of this session that this copy does not rewrite stay listed: finished or from an interrupted
      // publication, while they are still in place as recorded (Remove deletes them later).
      for (const entry of own) {
        const stat = walk(this.home, entry.rel, "file");

        if (!this.#staged.has(entry.rel) && !files.some((f) => f.rel === entry.rel) && stat && same(stat, entry))
          files.push(entry);
      }

      // Before any rename: every file that is, or may become, Canopy's own (earlier and pending).
      writeManifest(this.manifestPath, {
        home: identity(this.#homeId),
        files: own,
        dirs,
        size: this.#previous?.size ?? "",
        prefixSha256: this.#previous?.prefixSha256 ?? "",
        pending: { files: pending, size: snapshot.size, prefixSha256: snapshot.prefixSha256 },
      });

      // A rename replaces a name, never what a link points to; the file keeps its recorded inode.
      for (const [rel, staged] of this.#staged) {
        const parent = dirname(rel);

        if (parent !== "." && !walk(this.home, parent, "directory"))
          throw new CopyError("the private home changed while the copy was published");
        renameSync(staged, join(this.home, rel));
        moved.push(files.find((f) => f.rel === rel)!);
      }

      // Complete: the copy's files, final.
      writeManifest(this.manifestPath, {
        home: identity(this.#homeId),
        files,
        dirs,
        size: snapshot.size,
        prefixSha256: snapshot.prefixSha256,
      });
    } catch (cause) {
      this.#rollBack(moved);
      throw cause;
    } finally {
      this.abort();
    }
  }

  /** Drops the staging directory (it holds only what this copy wrote). */
  abort(): void {
    const stat = lstat(this.#staging);

    if (stat?.isDirectory() && !stat.isSymbolicLink()) rmSync(this.#staging, { recursive: true, force: true });
  }

  /** Real directories from the home down to `rel`, made when missing and recorded with their identity. */
  #directories(rel: string, made: Entry[]): void {
    if (rel === "." || rel === "") return;
    let current = this.home;
    let path = "";

    for (const part of rel.split(sep)) {
      current = join(current, part);
      path = path ? join(path, part) : part;
      let stat = lstat(current);

      if (!stat) {
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current, { bigint: true });
        made.push({ rel: path, ...identity(stat) });
      }

      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new CopyError("the private home holds a link or a file where a directory belongs");
    }
  }

  /**
   * After a failed publish: files this copy moved into place go, and the manifest lists what is still in place of
   * earlier copies (a retry may then write over exactly those).
   */
  #rollBack(moved: readonly Entry[]): void {
    for (const file of moved) {
      const stat = walk(this.home, file.rel, "file");

      if (stat && same(stat, file)) unlinkSync(join(this.home, file.rel));
    }

    const previous = this.#previous;

    const kept = [...(previous?.files ?? []), ...(previous?.pending?.files ?? [])].filter((f) => {
      const stat = walk(this.home, f.rel, "file");

      return stat !== undefined && same(stat, f);
    });

    // Not a complete copy any more (no snapshot): a later attempt writes over what is listed, Remove deletes it.
    if (previous && kept.length > 0)
      writeManifest(this.manifestPath, {
        home: previous.home,
        files: kept,
        dirs: previous.dirs,
        size: "",
        prefixSha256: "",
      });
    else rmSync(this.manifestPath, { force: true });
  }
}

function readManifest(path: string): Manifest | undefined {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  return Option.getOrUndefined(decodeManifest(text));
}

function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, CREATE, 0o600);

  try {
    writeSync(fd, JSON.stringify(manifest));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, path);
}

/**
 * Deletes what the manifest lists, below `home` (the private home the worker expects now): only when the home is the
 * recorded directory, through real directories, and only files and directories with their recorded identity.
 * Without a manifest, or for another home, nothing is deleted.
 */
export function removeCopy(manifestPath: string, home: string): void {
  const manifest = readManifest(manifestPath);

  if (!manifest) return;
  const root = lstat(home);

  if (!root?.isDirectory() || root.isSymbolicLink() || !same(root, manifest.home)) return;

  for (const file of [...manifest.files, ...(manifest.pending?.files ?? [])]) {
    const stat = walk(home, file.rel, "file");

    if (stat && same(stat, file) && openedSame(join(home, file.rel), file)) unlinkSync(join(home, file.rel));
  }

  for (const dir of manifest.dirs.toSorted((a, b) => b.rel.length - a.rel.length)) {
    const stat = walk(home, dir.rel, "directory");

    if (!stat || !same(stat, dir)) continue;

    try {
      rmdirSync(join(home, dir.rel));
    } catch {
      // Not empty (the CLI added files): left as it is.
    }
  }

  rmSync(manifestPath, { force: true });
}

/** The file at `path`, opened without following a link, is still the recorded one (right before its unlink). */
function openedSame(path: string, entry: Entry): boolean {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch {
    return false;
  }

  try {
    const stat = fstatSync(fd, { bigint: true });

    return stat.isFile() && same(stat, entry);
  } finally {
    closeSync(fd);
  }
}
