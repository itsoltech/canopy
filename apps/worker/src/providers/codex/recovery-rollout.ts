import { closeSync, createReadStream, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { compose } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { openSource } from "../../import/read.ts";
import { completeJsonlRecords, readJsonl } from "../harness-record.ts";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

const ROLLOUT_NAME = new RegExp(
  `^rollout-(\\d{4})-(\\d{2})-(\\d{2})T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_${UUID})?\\.jsonl$`,
  "i",
);

const MAX_COMPRESSED_TAIL_BYTES = 64 * 1024 * 1024;

/** Native archive/unarchive and compression preserve the exact rollout name and its uncompressed offsets. */
export function nativeRollout(path: string, sessionId: string) {
  if (!isAbsolute(path)) return undefined;
  const name = basename(path).replace(/\.zst$/, "");
  const match = ROLLOUT_NAME.exec(name);

  if (!match || match[4] !== sessionId) return undefined;
  const date = join(match[1]!, match[2]!, match[3]!);
  const directory = dirname(path);
  const archived = basename(directory) === "archived_sessions";
  const home = archived ? dirname(directory) : dirname(dirname(dirname(dirname(directory))));
  const active = join("sessions", date);

  if (!archived && directory !== join(home, active)) return undefined;

  return {
    home,
    name,
    locations: archived ? ["archived_sessions", active] : [active, "archived_sessions"],
  };
}

export async function readCodexRollout(path: string, offset: number, sessionId: string) {
  const native = nativeRollout(path, sessionId);

  if (!native) return path.endsWith(".zst") ? [] : readJsonl(path, offset);
  const root = realpathSync(native.home);

  for (const directory of native.locations) {
    const plain = join(root, directory, native.name);

    // The original is authoritative if a crash left both files, as in Codex's own resolver.
    for (const candidate of [plain, `${plain}.zst`]) {
      if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
      let fd: number;

      try {
        fd = openSource({ root, path: candidate });
      } catch (error) {
        if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
        throw error;
      }

      try {
        const text = candidate.endsWith(".zst")
          ? await compressedTail(candidate, fd, offset)
          : await Bun.file(fd).slice(Math.max(0, offset)).text();

        return completeJsonlRecords(text);
      } finally {
        closeSync(fd);
      }
    }
  }

  return [];
}

async function compressedTail(path: string, fd: number, offset: number): Promise<string> {
  const input = createReadStream(path, { fd, autoClose: false });
  const stream: AsyncIterable<Uint8Array> = compose(input, createZstdDecompress());
  const decoder = new TextDecoder();
  const text: string[] = [];
  let skip = Math.max(0, offset);
  let bytes = 0;

  for await (const chunk of stream) {
    const start = Math.min(chunk.byteLength, skip);
    skip -= start;
    bytes += chunk.byteLength - start;

    if (bytes > MAX_COMPRESSED_TAIL_BYTES) throw new Error("The compressed Codex rollout tail is too large");

    if (start < chunk.byteLength) text.push(decoder.decode(chunk.subarray(start), { stream: true }));
  }

  text.push(decoder.decode());

  return text.join("");
}
