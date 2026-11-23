import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FileResolution, type FileContentSchema, type FileDownloadRange } from "@canopy/contracts";
import { THREAD_FILE_DOWNLOAD_CHUNK_BYTES } from "@canopy/domain/thread-files";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { CommandError } from "../runtime/host-types.ts";

const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const MAX_POSITION = BigInt(Number.MAX_SAFE_INTEGER);

function revision(path: string, rootIdentity: string, stat: BigIntStats): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        path,
        rootIdentity,
        ...[stat.dev, stat.ino, stat.size, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs].map(String),
      ]),
    )
    .digest("hex");
}

const changed = () => new CommandError("FILE_CHANGED", "The file changed on disk. Download it again.", true);

/** The first range takes a resolved path. Subsequent ranges must reopen that exact file revision. */
export async function readThreadFileChunk(
  path: string,
  rootIdentity: string,
  { offset, expectedRevision, maxBytes }: FileDownloadRange,
): Promise<MessageInitShape<typeof FileContentSchema>> {
  if (!isAbsolute(path) || offset > MAX_POSITION)
    throw new CommandError("FILE_RANGE_INVALID", "Could not read this part of the file. Download it again.", true);

  try {
    const entry = await lstat(path, { bigint: true });

    if (!entry.isFile()) throw changed();
    const handle = await open(path, FLAGS);

    try {
      const stat = await handle.stat({ bigint: true });
      const current = revision(path, rootIdentity, stat);

      if (
        !stat.isFile() ||
        current !== revision(path, rootIdentity, entry) ||
        (expectedRevision && current !== expectedRevision)
      )
        throw changed();

      if (stat.size > MAX_POSITION)
        throw new CommandError(
          "FILE_RANGE_INVALID",
          "This file is too large to download. Split it into smaller files.",
          true,
        );

      if (offset > 0n && offset >= stat.size) throw changed();
      const remaining = Number(stat.size - offset);
      const limit = Math.min(maxBytes || THREAD_FILE_DOWNLOAD_CHUNK_BYTES, THREAD_FILE_DOWNLOAD_CHUNK_BYTES);
      const length = Math.min(remaining, limit);
      // Some regular files (for example in procfs) report a size that differs from their actual byte count.
      const buffer = new Uint8Array(length + Number(length === remaining));
      let read = 0;

      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, Number(offset) + read);

        if (!bytesRead) break;
        read += bytesRead;
      }

      if (
        read !== length ||
        current !== revision(path, rootIdentity, await handle.stat({ bigint: true })) ||
        current !== revision(path, rootIdentity, await lstat(path, { bigint: true }))
      )
        throw changed();

      return {
        path,
        content: buffer.subarray(0, length),
        size: stat.size,
        resolution: FileResolution.FOUND,
        downloadChunk: { offset, revision: current },
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof CommandError) throw cause;

    if (expectedRevision) throw changed();

    throw new CommandError(
      "FILE_READ_FAILED",
      "Could not read this file. Check its path and permissions, then retry.",
      true,
    );
  }
}
