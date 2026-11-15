import { create } from "@bufbuild/protobuf";
import {
  WorkspaceCopyChunkSchema,
  WorkspaceCopyReadSchema,
  type WorkspaceCopyBatch,
  type WorkspaceCopyChunk,
  type WorkspaceCopyEntry,
  type WorkspaceCopyRead,
  type WorkspaceCopyStaged,
} from "@canopy/contracts";
import { createHash } from "node:crypto";
import { COPY_FRAME_BYTES, COPY_FRAME_FILES, COPY_LANES } from "@canopy/domain/workspace-copy";
import { InvalidError } from "../core/core-context.ts";

/** Reads one frame from the source home, writes one frame to the target home. */
export interface TransferIo {
  read(reads: WorkspaceCopyRead[]): Promise<WorkspaceCopyBatch>;
  write(chunks: WorkspaceCopyChunk[]): Promise<void>;
}

export interface TransferTick {
  bytes: number;
  files: number;
  current: WorkspaceCopyEntry;
}

/** Whole files that fit a frame share it; larger ones stream frame by frame, in order, in one lane. */
type Item = { kind: "pack"; files: WorkspaceCopyEntry[] } | { kind: "large"; file: WorkspaceCopyEntry };

/** Files up to this size are packed; larger ones get frames of their own. */
const PACKED_BYTES = COPY_FRAME_BYTES / 4;

const lost = () => new InvalidError("The transfer lost its place. Retry the copy.");
const corrupt = () => new InvalidError("File integrity check failed. Retry the copy.");

/**
 * Copies `files` with COPY_LANES frames in flight; memory stays below lanes × frame size. Files the target staged
 * earlier are confirmed by hash with the source and not sent again. Returns every file's SHA-256.
 */
export async function transferFiles(
  token: { source: string; target: string },
  files: readonly WorkspaceCopyEntry[],
  staged: ReadonlyMap<string, WorkspaceCopyStaged>,
  io: TransferIo,
  signal: AbortSignal,
  tick: (progress: TransferTick) => void,
): Promise<Map<string, string>> {
  const known = (entry: WorkspaceCopyEntry) => {
    const found = staged.get(entry.path);

    return found && found.size === entry.size ? found.sha256 : "";
  };

  const hashes = new Map<string, string>();
  const items = plan(files);
  const packs = items.filter((item) => item.kind === "pack");
  const larges = items.filter((item) => item.kind === "large");
  const stop = new AbortController();
  const both = AbortSignal.any([signal, stop.signal]);

  // Half the lanes take packed small files first, half large ones: files complete (and count) from the start
  // even when a few large assets come first in the manifest, and large files still move in parallel.
  const lane = async (index: number) => {
    const [first, second] = index % 2 === 0 ? [packs, larges] : [larges, packs];

    for (let item = first.shift() ?? second.shift(); item; item = first.shift() ?? second.shift()) {
      both.throwIfAborted();

      if (item.kind === "pack") await pack(item.files);
      else await large(item.file);
    }
  };

  const read = (entry: WorkspaceCopyEntry, offset: bigint, maxBytes: number, knownSha256 = "") =>
    create(WorkspaceCopyReadSchema, { token: token.source, path: entry.path, offset, maxBytes, knownSha256 });

  const outgoing = (chunk: WorkspaceCopyChunk) => create(WorkspaceCopyChunkSchema, { ...chunk, token: token.target });

  async function pack(entries: WorkspaceCopyEntry[]) {
    const batch = await io.read(entries.map((e) => read(e, 0n, Number(e.size), known(e))));

    if (batch.chunks.length !== entries.length) throw lost();

    const chunks = entries.map((entry, i) => {
      // SAFETY: the length matches `entries` (checked above).
      const chunk = batch.chunks[i]!;

      if (chunk.path !== entry.path || chunk.offset !== 0n || !chunk.last) throw lost();
      verify(entry, chunk, known(entry));

      return chunk;
    });

    await io.write(chunks.map(outgoing));

    for (const [i, entry] of entries.entries()) {
      // SAFETY: as above.
      hashes.set(entry.path, chunks[i]!.sha256);
      tick({ bytes: Number(entry.size), files: 1, current: entry });
    }
  }

  async function large(entry: WorkspaceCopyEntry) {
    let offset = 0n;

    for (;;) {
      both.throwIfAborted();
      const left = Number(entry.size - offset);
      const batch = await io.read([read(entry, offset, Math.min(COPY_FRAME_BYTES, left), offset ? "" : known(entry))]);
      const chunk = batch.chunks[0];

      if (batch.chunks.length !== 1 || !chunk || chunk.path !== entry.path || chunk.offset !== offset) throw lost();

      if (chunk.unchanged) {
        verify(entry, chunk, known(entry));
        await io.write([outgoing(chunk)]);
        hashes.set(entry.path, chunk.sha256);
        tick({ bytes: Number(entry.size), files: 1, current: entry });

        return;
      }

      offset += BigInt(chunk.data.length);

      if (offset > entry.size || (chunk.last && offset !== entry.size) || (!chunk.last && !chunk.data.length))
        throw corrupt();

      if (chunk.last && !/^[0-9a-f]{64}$/.test(chunk.sha256)) throw corrupt();
      await io.write([outgoing(chunk)]);
      tick({ bytes: chunk.data.length, files: chunk.last ? 1 : 0, current: entry });

      if (chunk.last) {
        hashes.set(entry.path, chunk.sha256);

        return;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: COPY_LANES }, (_, index) => lane(index)));
  } catch (error) {
    stop.abort();
    throw error;
  }

  return hashes;
}

/**
 * Sizes and the source's hashes are checked here; the bytes are hashed by the target, which refuses a file whose
 * content does not match the source's SHA-256, and both sides agree on the total digest before publishing.
 */
function verify(entry: WorkspaceCopyEntry, chunk: WorkspaceCopyChunk, known: string) {
  if (
    chunk.unchanged
      ? chunk.sha256 !== known
      : BigInt(chunk.data.length) !== entry.size || !/^[0-9a-f]{64}$/.test(chunk.sha256)
  )
    throw corrupt();
}

function plan(files: readonly WorkspaceCopyEntry[]): Item[] {
  const items: Item[] = [];
  let current: WorkspaceCopyEntry[] = [];
  let bytes = 0;

  const flush = () => {
    if (current.length) items.push({ kind: "pack", files: current });
    current = [];
    bytes = 0;
  };

  for (const file of files) {
    const size = Number(file.size);

    if (size > PACKED_BYTES) {
      items.push({ kind: "large", file });
      continue;
    }

    if (bytes + size > COPY_FRAME_BYTES || current.length >= COPY_FRAME_FILES) flush();
    current.push(file);
    bytes += size;
  }

  flush();

  return items;
}

/** The whole transfer's digest: the target computes the same over its verified files before publishing. */
export function totalDigest(files: readonly WorkspaceCopyEntry[], hashes: ReadonlyMap<string, string>) {
  const total = createHash("sha256");

  for (const e of files) total.update(`${e.path}\0${e.size}\0${hashes.get(e.path) ?? ""}\n`);

  return total.digest("hex");
}
