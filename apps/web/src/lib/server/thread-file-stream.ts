import { error, json } from "@sveltejs/kit";
import type { Client } from "@connectrpc/connect";
import { FileResolution, type ui } from "@canopy/contracts";
import { attachmentRange, videoType } from "@canopy/domain";
import { THREAD_FILE_DOWNLOAD_CHUNK_BYTES } from "@canopy/domain/thread-files";
import { fileDisposition } from "./files.ts";

type FileApi = Pick<Client<typeof ui.GatewayService>, "readThreadFile">;

type Target = { threadId: string; path: string; itemId: string };

type Mode = "download" | "check" | "video";

const TIMEOUT_MS = 35_000;

// The container sniffer inspects at most the 4 KiB WebM header or the MP4/MOV file type box header.
const VIDEO_HEADER_BYTES = 4096;
const CHANGED = "The file changed during the transfer. Open it again.";
export const FILE_TRANSFER_UPDATE = "Update Canopy on the computer that holds this file, then retry.";

function downloadName(path: string): string {
  const name = path
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\p{Cc}\p{Bidi_Control}<>:"|?*]/gu, "_")
    .trim()
    .replace(/[. ]+$/, "");

  if (!name) return "download";

  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(name) ? "_" + name : name;
}

function validChunk(file: ui.ThreadFile, first: ui.ThreadFile, offset: number, limit: number): boolean {
  // Workers predating max_bytes always return up to one full chunk, even for a two-byte range.
  const fullChunk = Math.min(Number(first.size) - offset, THREAD_FILE_DOWNLOAD_CHUNK_BYTES);

  return (
    file.resolution === FileResolution.FOUND &&
    !file.truncated &&
    file.path === first.path &&
    file.size === first.size &&
    file.downloadChunk?.offset === BigInt(offset) &&
    file.downloadChunk.revision === first.downloadChunk?.revision &&
    (file.content.length === Math.min(limit, fullChunk) || file.content.length === fullChunk)
  );
}

export async function threadFileStream(api: FileApi, target: Target, request: Request, mode: Mode): Promise<Response> {
  const abort = new AbortController();
  const options = { signal: AbortSignal.any([request.signal, abort.signal]), timeoutMs: TIMEOUT_MS };
  const video = mode === "video";
  const limit = video ? VIDEO_HEADER_BYTES : THREAD_FILE_DOWNLOAD_CHUNK_BYTES;
  const first = await api.readThreadFile({ ...target, downloadRange: { maxBytes: limit } }, options);

  if (first.resolution === FileResolution.AMBIGUOUS || first.searchIncomplete)
    error(409, "Canopy could not choose one file. Use the full path.");

  if (first.resolution === FileResolution.NOT_FOUND || first.resolution === FileResolution.DELETED)
    error(404, "Canopy could not find this file. Check its path, then retry.");

  const revision = first.downloadChunk?.revision;

  if (!revision) error(426, FILE_TRANSFER_UPDATE);
  const size = Number(first.size);

  if (
    !first.path ||
    !Number.isSafeInteger(size) ||
    !/^[a-f0-9]{64}$/.test(revision) ||
    !validChunk(first, first, 0, limit)
  )
    error(409, CHANGED);

  if (mode === "check") return json({});

  const mimeType = video ? videoType(first.content, size) : "application/octet-stream";

  if (!mimeType) error(415, "Canopy cannot play this file. Open it in another app.");

  const headers = new Headers({
    "content-type": mimeType,
    "content-disposition": fileDisposition(downloadName(first.path), video),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });

  const etag = `"${revision}"`;

  if (video) {
    headers.set("accept-ranges", "bytes");
    headers.set("etag", etag);
    headers.set("x-accel-buffering", "no");
  }

  const ifRange = request.headers.get("if-range");

  const rangeHeader =
    video && request.method === "GET" && (ifRange === null || ifRange === etag) ? request.headers.get("range") : null;

  const range = rangeHeader === null ? { start: 0, end: size - 1 } : attachmentRange(rangeHeader, size);

  if (!range) {
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");

    return new Response(null, { status: 416, headers });
  }

  const { start, end } = range;
  headers.set("content-length", String(end - start + 1));

  if (rangeHeader !== null) headers.set("content-range", `bytes ${start}-${end}/${size}`);

  let offset = start;

  const body =
    size === 0 || request.method === "HEAD"
      ? null
      : new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                let bytes: Uint8Array;

                if (offset < first.content.length) {
                  bytes = first.content.subarray(offset, end + 1);
                } else {
                  const maxBytes = Math.min(THREAD_FILE_DOWNLOAD_CHUNK_BYTES, end - offset + 1);

                  const chunk = await api.readThreadFile(
                    {
                      threadId: target.threadId,
                      path: first.path,
                      downloadRange: { offset: BigInt(offset), expectedRevision: revision, maxBytes },
                    },
                    options,
                  );

                  if (!validChunk(chunk, first, offset, maxBytes)) throw new Error(CHANGED);
                  bytes = chunk.content.subarray(0, maxBytes);
                }

                options.signal.throwIfAborted();
                offset += bytes.length;
                controller.enqueue(bytes);

                if (offset > end) controller.close();
              } catch (cause) {
                abort.abort();
                controller.error(cause);
              }
            },
            cancel() {
              abort.abort();
            },
          },
          { highWaterMark: 0 },
        );

  return new Response(body, { status: rangeHeader === null ? 200 : 206, headers });
}
