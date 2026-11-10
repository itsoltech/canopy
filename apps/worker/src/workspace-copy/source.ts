import { createHash, type Hash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { WorkspaceCopyChunkSchema, type WorkspaceCopyRead, type WorkspaceCopyAuthorize } from "@canopy/contracts";
import { COPY_CHUNK_BYTES, COPY_IDLE_MS, COPY_MAX_FILE_BYTES } from "@canopy/domain/workspace-copy";
import { readHandle, copyError } from "./safety.ts";
import { scanWorkspace, type CopyScan } from "./scan.ts";

interface SourceSession {
  scan: CopyScan;
  expires: number;
  selected?: Set<string>;
  reading?: { path: string; offset: number; hash: Hash };
}

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
      this.#sessions.set(scan.manifest.token, { scan, expires: Date.now() + COPY_IDLE_MS });

      return scan.manifest;
    } finally {
      this.#scanning--;
    }
  }

  release(token: string) {
    this.#sessions.delete(token);
  }

  authorize(request: WorkspaceCopyAuthorize) {
    const session = this.#sessions.get(request.token);

    if (!session || session.expires < Date.now()) throw copyError("The file list expired. Refresh it before copying.");
    delete session.selected;
    const paths = new Set(request.paths);
    const entries = session.scan.manifest.entries;

    if (entries.some((e) => !e.ignored && (!paths.has(e.path) || e.blocked)))
      throw copyError("Copy the complete repository. Refresh the file list and retry.");

    if (entries.filter((e) => paths.has(e.path) && !e.blocked).length !== paths.size)
      throw copyError("The selection includes an unavailable file.");
    session.selected = paths;
    session.expires = Date.now() + COPY_IDLE_MS;
  }

  async read(request: WorkspaceCopyRead) {
    const session = this.#sessions.get(request.token);

    if (!session || session.expires < Date.now()) throw copyError("The file list expired. Refresh it before copying.");
    session.expires = Date.now() + COPY_IDLE_MS;
    const entry = session.scan.manifest.entries.find((e) => e.path === request.path);

    if (!entry || entry.directory || entry.blocked || !session.selected?.has(request.path))
      throw copyError("This file was not selected for copying.");

    if (entry.size > COPY_MAX_FILE_BYTES) throw copyError("A selected file exceeds the 8 GB per-file limit.");
    const offset = Number(request.offset);
    const reading = offset === 0 ? { path: entry.path, offset: 0, hash: createHash("sha256") } : session.reading;

    if (!reading || reading.path !== entry.path || reading.offset !== offset)
      throw copyError("The transfer lost its place. Retry the copy.");
    session.reading = reading;
    let data: Uint8Array;

    if (entry.symlink) {
      if (offset !== 0) throw copyError("Invalid symlink offset.");
      const file = session.scan.files.get(entry.path);

      if (!file || (await readlink(join(file.root, file.path))) !== entry.symlink)
        throw copyError("A symlink changed after the preview. Refresh the file list.");
      // Symlinks are never followed; their literal target is the payload.
      data = Buffer.from(entry.symlink);
    } else {
      const file = session.scan.files.get(entry.path);

      if (!file) throw copyError("The file list changed. Refresh it.");
      const { handle, info } = await readHandle(file.root, file.path);

      try {
        if (info.size !== file.size || info.mtimeMs !== file.mtime || info.ino !== file.ino || info.dev !== file.dev)
          throw copyError("A file changed after the preview. Refresh the file list and retry.");

        if (offset < 0 || offset > file.size) throw copyError("Invalid file offset.");
        const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, file.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        data = buffer.subarray(0, bytesRead);
        const after = await lstat(join(file.root, file.path));

        if (after.mtimeMs !== file.mtime || after.ino !== file.ino)
          throw copyError("A file changed while copying. Refresh and retry.");
      } finally {
        await handle.close();
      }
    }

    reading.hash.update(data);
    reading.offset += data.byteLength;
    const last = reading.offset === Number(entry.size);

    if (!last && data.length === 0) throw copyError("A file changed while copying. Refresh and retry.");

    return create(WorkspaceCopyChunkSchema, {
      token: request.token,
      path: entry.path,
      offset: request.offset,
      data,
      last,
      sha256: last ? reading.hash.digest("hex") : "",
    });
  }
}
