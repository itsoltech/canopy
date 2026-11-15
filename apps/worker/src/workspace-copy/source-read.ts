import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { COPY_FRAME_BYTES } from "@canopy/domain/workspace-copy";
import { readHandle, copyError } from "./safety.ts";
import type { ScannedFile } from "./scan.ts";

/** A symlink is never followed: its literal target is the payload. */
export async function readSymlink(file: ScannedFile, expected: string): Promise<Buffer> {
  if ((await readlink(join(file.root, file.path))) !== expected)
    throw copyError("A symlink changed after the preview. Refresh the file list.");

  return Buffer.from(expected);
}

/** Bytes of a regular file at `offset`, refused when the file is no longer the one the preview listed. */
export async function readRange(file: ScannedFile, offset: number, length: number): Promise<Buffer> {
  const { handle, info } = await readHandle(file.root, file.path);

  try {
    unchanged(file, info);

    if (offset < 0 || offset > file.size) throw copyError("Invalid file offset.");
    const buffer = Buffer.allocUnsafe(Math.min(length, file.size - offset));
    let read = 0;

    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);

      if (!bytesRead) break;
      read += bytesRead;
    }

    await stillSame(file);

    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** SHA-256 of a whole regular file, read locally in frame-sized pieces; used to skip files a target already has. */
export async function hashFile(file: ScannedFile): Promise<string> {
  const { handle, info } = await readHandle(file.root, file.path);
  const hash = createHash("sha256");

  try {
    unchanged(file, info);
    const buffer = Buffer.allocUnsafe(Math.min(COPY_FRAME_BYTES, Math.max(file.size, 1)));
    let offset = 0;

    while (offset < file.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);

      if (!bytesRead) throw copyError("A file changed while copying. Refresh and retry.");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    await stillSame(file);

    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function unchanged(file: ScannedFile, info: { size: number; mtimeMs: number; ino: number; dev: number }) {
  if (info.size !== file.size || info.mtimeMs !== file.mtime || info.ino !== file.ino || info.dev !== file.dev)
    throw copyError("A file changed after the preview. Refresh the file list and retry.");
}

async function stillSame(file: ScannedFile) {
  const after = await lstat(join(file.root, file.path));

  if (after.mtimeMs !== file.mtime || after.ino !== file.ino)
    throw copyError("A file changed while copying. Refresh and retry.");
}
