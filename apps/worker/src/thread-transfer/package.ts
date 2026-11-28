import { createHash, type Hash } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  WorkspaceCopyBatchSchema,
  WorkspaceCopyChunkSchema,
  WorkspaceCopyEntrySchema,
  type WorkspaceCopyBatch,
  type WorkspaceCopyChunk,
  type WorkspaceCopyEntry,
  type WorkspaceCopyRead,
  type WorkspaceCopyReadBatch,
} from "@canopy/contracts";
import {
  COPY_FRAME_BYTES,
  COPY_FRAME_FILES,
  COPY_IDLE_MS,
  COPY_MAX_BYTES,
  COPY_MAX_ENTRIES,
  COPY_MAX_FILE_BYTES,
  copySafePath,
  copyTotals,
} from "@canopy/domain/workspace-copy";
import { readRange } from "../workspace-copy/source-read.ts";
import type { ScannedFile } from "../workspace-copy/scan.ts";
import { checkedPath } from "../workspace-copy/safety.ts";
import { settle, syncFiles, writePiece } from "../workspace-copy/target-files.ts";
import { mapLimit } from "../workspace-copy/limit.ts";
import { transferError } from "./errors.ts";

/**
 * The bytes of a thread transfer (docs/thread-transfers.md): a package of plain files the source builds in a
 * private directory, read frame by frame by the gateway and written into a private staging directory on the target.
 * Only regular files; the target hashes every file and the whole package before anything is applied.
 */

const READ_CONCURRENCY = 8;
const WRITE_CONCURRENCY = 8;

/** Moves one worker holds at once, and their bytes; each keeps a staging directory until released or cancelled. */
const MAX_RECEIVING = 4;
const MAX_HELD_BYTES = 2n * BigInt(COPY_MAX_BYTES);

interface SourcePackage {
  dir: string;
  files: Map<string, { entry: WorkspaceCopyEntry; file: ScannedFile }>;
  reading: Map<string, { offset: number; hash: Hash }>;
  expires: number;
}

/** Every regular file below `dir` as a package entry; links and special files are refused (the source made them). */
export async function packageEntries(dir: string): Promise<{ entries: WorkspaceCopyEntry[]; files: ScannedFile[] }> {
  const files: ScannedFile[] = [];

  const walk = async (path: string) => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);

      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        const info = await lstat(full);
        const rel = relative(dir, full).split(sep).join("/");
        files.push({ root: dir, path: rel, size: info.size, mtime: info.mtimeMs, ino: info.ino, dev: info.dev });
      } else throw transferError("The transfer package holds a file that is not a regular file.");
    }
  };

  await walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const entries = files.map((f) =>
    create(WorkspaceCopyEntrySchema, { path: f.path, size: BigInt(f.size), mode: 0o600, included: true }),
  );

  checkEntries(entries);

  return { entries, files };
}

export function checkEntries(entries: readonly WorkspaceCopyEntry[]): bigint {
  const totals = copyTotals(entries);

  if (entries.length > COPY_MAX_ENTRIES || totals.bytes > COPY_MAX_BYTES)
    throw transferError("The thread is too large to move (20 GB, 100,000 files).");
  const paths = new Set<string>();

  for (const entry of entries) {
    if (entry.directory || entry.symlink || !copySafePath(entry.path) || entry.size > COPY_MAX_FILE_BYTES)
      throw transferError("The transfer package holds a path that cannot be moved.");
    const key = entry.path.toLowerCase();

    if (paths.has(key)) throw transferError("The transfer package holds two paths that differ only in case.");
    paths.add(key);
  }

  return totals.bytes;
}

/** Packages this worker built and the gateway is reading. */
export class PackageSources {
  readonly #packages = new Map<string, SourcePackage>();

  open(token: string, dir: string, files: readonly ScannedFile[], entries: readonly WorkspaceCopyEntry[]) {
    const byPath = new Map<string, { entry: WorkspaceCopyEntry; file: ScannedFile }>();

    for (const [i, file] of files.entries()) byPath.set(file.path, { entry: entries[i]!, file });
    this.#packages.set(token, { dir, files: byPath, reading: new Map(), expires: Date.now() + COPY_IDLE_MS });
  }

  /** Forgets the package and deletes its directory. */
  async release(token: string, dir: string) {
    this.#packages.delete(token);
    await rm(dir, { recursive: true, force: true });
  }

  async readBatch(request: WorkspaceCopyReadBatch): Promise<WorkspaceCopyBatch> {
    const pkg = this.#packages.get(request.token);

    if (!pkg || pkg.expires < Date.now()) throw transferError("The transfer expired. Start the move again.");
    pkg.expires = Date.now() + COPY_IDLE_MS;

    if (
      request.reads.length > COPY_FRAME_FILES ||
      new Set(request.reads.map((r) => r.path)).size !== request.reads.length ||
      request.reads.reduce((sum, r) => sum + r.maxBytes, 0) > COPY_FRAME_BYTES
    )
      throw transferError("The transfer frame is too large.");

    const chunks = await mapLimit(request.reads, READ_CONCURRENCY, (read) => this.#read(pkg, read));

    return create(WorkspaceCopyBatchSchema, { token: request.token, chunks });
  }

  async #read(pkg: SourcePackage, request: WorkspaceCopyRead): Promise<WorkspaceCopyChunk> {
    const found = pkg.files.get(request.path);

    if (!found) throw transferError("This file is not part of the transfer.");
    const offset = Number(request.offset);
    const reading = offset === 0 ? { offset: 0, hash: createHash("sha256") } : pkg.reading.get(request.path);

    if (!reading || reading.offset !== offset)
      throw transferError("The transfer lost its place. Start the move again.");
    const data = await readRange(found.file, offset, Math.max(1, request.maxBytes));
    reading.hash.update(data);
    reading.offset += data.byteLength;
    const last = reading.offset === found.file.size;

    if (!last && data.length === 0) throw transferError("A package file changed while moving.");

    if (last) pkg.reading.delete(request.path);
    else pkg.reading.set(request.path, reading);

    return create(WorkspaceCopyChunkSchema, {
      token: request.token,
      path: request.path,
      offset: request.offset,
      data,
      last,
      sha256: last ? reading.hash.digest("hex") : "",
    });
  }
}

interface TargetSession {
  stage: string;
  entries: Map<string, WorkspaceCopyEntry>;
  done: Map<string, string>;
  writing: Map<string, { offset: number; hash: Hash }>;
  dirs: Set<string>;
}

/** Staging directories of packages being received. */
export class PackageTargets {
  readonly #sessions = new Map<string, TargetSession>();
  /** Staged bytes per transfer, held from prepare until the transfer is released or cancelled (also once applied). */
  readonly #held = new Map<string, bigint>();

  async prepare(token: string, stage: string, entries: readonly WorkspaceCopyEntry[], bytes: bigint) {
    if (checkEntries(entries) !== bytes) throw transferError("The transfer size does not match its files.");
    const others = [...this.#held].filter(([t]) => t !== token);

    // Taken before any await, so two prepares can't both pass.
    if (others.length >= MAX_RECEIVING || others.reduce((sum, [, b]) => sum + b, bytes) > MAX_HELD_BYTES)
      throw transferError("This worker is receiving other moves. Try again in a moment.");
    this.#held.set(token, bytes);

    try {
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.#held.delete(token);
      throw error;
    }

    this.#sessions.set(token, {
      stage,
      entries: new Map(entries.map((e) => [e.path, e])),
      done: new Map(),
      writing: new Map(),
      dirs: new Set(),
    });
  }

  async writeBatch(batch: WorkspaceCopyBatch) {
    const session = this.#sessions.get(batch.token);

    if (!session) throw transferError("The transfer expired. Start the move again.");

    if (
      batch.chunks.length > COPY_FRAME_FILES ||
      new Set(batch.chunks.map((c) => c.path)).size !== batch.chunks.length ||
      batch.chunks.reduce((sum, c) => sum + c.data.length, 0) > COPY_FRAME_BYTES
    )
      throw transferError("Unexpected transfer chunk.");
    await mapLimit(batch.chunks, WRITE_CONCURRENCY, (chunk) => this.#write(session, chunk));
  }

  async #write(session: TargetSession, chunk: WorkspaceCopyChunk) {
    const entry = session.entries.get(chunk.path);

    if (!entry || chunk.unchanged || session.done.has(entry.path)) throw transferError("Unexpected transfer chunk.");
    const writing = chunk.offset === 0n ? { offset: 0, hash: createHash("sha256") } : session.writing.get(entry.path);

    if (
      !writing ||
      BigInt(writing.offset) !== chunk.offset ||
      chunk.offset + BigInt(chunk.data.length) > entry.size ||
      (chunk.data.length === 0 && !chunk.last)
    )
      throw transferError("The transfer lost its place. Start the move again.");
    session.writing.delete(entry.path);
    await writePiece(session.stage, entry, chunk, session.dirs);
    writing.hash.update(chunk.data);
    writing.offset += chunk.data.length;

    if (!chunk.last) {
      session.writing.set(entry.path, writing);

      return;
    }

    const hash = writing.hash.digest("hex");

    if (BigInt(writing.offset) !== entry.size || hash !== chunk.sha256)
      throw transferError("File integrity check failed. Start the move again.");
    await settle(session.stage, entry);
    session.done.set(entry.path, hash);
  }

  /** Every file arrived with the hash the source sent, and their digest is the gateway's. Then the session ends. */
  async complete(token: string, sha256: string): Promise<string> {
    const session = this.#sessions.get(token);

    if (!session) throw transferError("The transfer expired. Start the move again.");
    const files = [...session.entries.values()];

    if (files.some((e) => !session.done.has(e.path))) throw transferError("The transfer is incomplete.");
    const total = createHash("sha256");

    for (const e of files) total.update(`${e.path}\0${e.size}\0${session.done.get(e.path)}\n`);

    if (total.digest("hex") !== sha256) throw transferError("Transfer integrity check failed. Start the move again.");
    await syncFiles(session.stage, files);
    this.#sessions.delete(token);

    return session.stage;
  }

  /** A staging directory still on disk after a restart counts until it is released or cancelled. */
  hold(token: string, bytes: bigint) {
    this.#held.set(token, bytes);
  }

  /** Released or cancelled: the staging directory is gone. */
  forget(token: string) {
    this.#sessions.delete(token);
    this.#held.delete(token);
  }
}

/** A package file below the staging directory, never outside it. */
export const stagedPath = (stage: string, path: string) => checkedPath(stage, path);
