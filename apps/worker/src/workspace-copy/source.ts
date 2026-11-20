import { createHash, type Hash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  WorkspaceCopyBatchSchema,
  WorkspaceCopyChunkSchema,
  type WorkspaceCopyAuthorize,
  type WorkspaceCopyEntry,
  type WorkspaceCopyRead,
  type WorkspaceCopyReadBatch,
} from "@canopy/contracts";
import {
  COPY_CHUNK_BYTES,
  COPY_FRAME_BYTES,
  COPY_FRAME_FILES,
  COPY_IDLE_MS,
  COPY_MAX_FILE_BYTES,
} from "@canopy/domain/workspace-copy";
import { copyError } from "./safety.ts";
import { scanWorkspace, type CopyScan } from "./scan.ts";
import { hashFile, readRange, readSymlink } from "./source-read.ts";
import { mapLimit } from "./limit.ts";
import { COPY_GIT_CONFIG } from "./git-metadata.ts";

interface SourceSession {
  scan: CopyScan;
  entries: Map<string, WorkspaceCopyEntry>;
  expires: number;
  selected?: Set<string>;
  /** Large files read piece by piece, in order; a few at once (one per gateway lane). */
  reading: Map<string, { offset: number; hash: Hash }>;
}

/** Files of one frame read at the same time; local disks and network filesystems both gain from some overlap. */
const READ_CONCURRENCY = 8;
const OPEN_LARGE_FILES = 32;

export class CopySources {
  readonly #sessions = new Map<string, SourceSession>();
  #scanning = 0;

  async scan(root: string) {
    for (const [token, s] of this.#sessions) if (s.expires < Date.now()) this.#sessions.delete(token);

    if (this.#sessions.size + this.#scanning >= 4)
      throw copyError("Four file lists are already open. Close one or wait 10 minutes.");
    this.#scanning++;

    try {
      const scan = await scanWorkspace(root);
      this.#sessions.set(scan.manifest.token, {
        scan,
        entries: new Map(scan.manifest.entries.map((e) => [e.path, e])),
        expires: Date.now() + COPY_IDLE_MS,
        reading: new Map(),
      });

      return scan.manifest;
    } finally {
      this.#scanning--;
    }
  }

  release(token: string) {
    this.#sessions.delete(token);
  }

  authorize(request: WorkspaceCopyAuthorize) {
    const session = this.#session(request.token);
    delete session.selected;
    const paths = new Set(request.paths);
    const entries = session.scan.manifest.entries;

    if (entries.some((e) => !e.ignored && (!paths.has(e.path) || e.blocked)))
      throw copyError("Copy the complete repository. Refresh the file list and retry.");

    if (entries.filter((e) => paths.has(e.path) && !e.blocked).length !== paths.size)
      throw copyError("The selection includes an unavailable file.");
    session.selected = paths;
    session.reading.clear();
  }

  /** The single-chunk read of gateways before workspace_copy_batch_v3. */
  read(request: WorkspaceCopyRead) {
    return this.#read(this.#session(request.token), request, COPY_CHUNK_BYTES);
  }

  /** One frame: whole small files and pieces of large ones, never more than the frame size in total. */
  async readBatch(request: WorkspaceCopyReadBatch) {
    const session = this.#session(request.token);
    const paths = new Set(request.reads.map((r) => r.path));

    if (
      request.reads.length > COPY_FRAME_FILES ||
      paths.size !== request.reads.length ||
      request.reads.reduce((sum, r) => sum + r.maxBytes, 0) > COPY_FRAME_BYTES
    )
      throw copyError("The transfer frame is too large. Retry the copy.");

    const chunks = await mapLimit(request.reads, READ_CONCURRENCY, (read) =>
      this.#read(session, read, Math.max(1, read.maxBytes)),
    );

    return create(WorkspaceCopyBatchSchema, { token: request.token, chunks });
  }

  #session(token: string) {
    const session = this.#sessions.get(token);

    if (!session || session.expires < Date.now()) throw copyError("The file list expired. Refresh it before copying.");
    session.expires = Date.now() + COPY_IDLE_MS;

    return session;
  }

  async #read(session: SourceSession, request: WorkspaceCopyRead, limit: number) {
    const entry = session.entries.get(request.path);

    if (
      request.token !== session.scan.manifest.token ||
      !entry ||
      entry.directory ||
      entry.blocked ||
      !session.selected?.has(request.path)
    )
      throw copyError("This file was not selected for copying.");

    if (entry.size > COPY_MAX_FILE_BYTES) throw copyError("A selected file exceeds the 8 GB per-file limit.");
    const config = entry.path === COPY_GIT_CONFIG ? session.scan.config : undefined;
    const file = session.scan.files.get(entry.path);
    const offset = Number(request.offset);

    if (!file && !config) throw copyError("The file list changed. Refresh it.");

    if (request.knownSha256 && offset === 0) {
      // SAFETY: a regular transfer entry has a scanned file unless it is the generated config above.
      const sha256 = config
        ? createHash("sha256").update(config).digest("hex")
        : entry.symlink
          ? createHash("sha256")
              .update(await readSymlink(file!, entry.symlink))
              .digest("hex")
          : await hashFile(file!);

      if (sha256 === request.knownSha256)
        return create(WorkspaceCopyChunkSchema, { ...base(request), last: true, sha256, unchanged: true });
    }

    const reading = offset === 0 ? { offset: 0, hash: createHash("sha256") } : session.reading.get(entry.path);

    if (!reading || reading.offset !== offset) throw copyError("The transfer lost its place. Retry the copy.");

    if (entry.symlink && offset !== 0) throw copyError("Invalid symlink offset.");

    // SAFETY: the same lookup validated above covers both regular files and symlinks.
    const data = config
      ? config.subarray(offset, offset + limit)
      : entry.symlink
        ? await readSymlink(file!, entry.symlink)
        : await readRange(file!, offset, limit);

    reading.hash.update(data);
    reading.offset += data.byteLength;
    const last = reading.offset === Number(entry.size);

    if (!last && data.length === 0) throw copyError("A file changed while copying. Refresh and retry.");

    if (last) session.reading.delete(entry.path);
    else {
      if (!session.reading.has(entry.path) && session.reading.size >= OPEN_LARGE_FILES)
        throw copyError("Too many files are being read at once. Retry the copy.");
      session.reading.set(entry.path, reading);
    }

    return create(WorkspaceCopyChunkSchema, {
      ...base(request),
      data,
      last,
      sha256: last ? reading.hash.digest("hex") : "",
    });
  }
}

const base = (request: WorkspaceCopyRead) => ({ token: request.token, path: request.path, offset: request.offset });
