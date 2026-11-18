import { error, json } from "@sveltejs/kit";
import { Code, ConnectError } from "@connectrpc/connect";
import { FileResolution, type ui } from "@canopy/contracts";
import { THREAD_FILE_DOWNLOAD_CHUNK_BYTES } from "@canopy/domain/thread-files";
import { fileDisposition } from "#lib/server/files.ts";
import { failWith, gateway } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

const TIMEOUT_MS = 35_000;
const CHUNK_BYTES = BigInt(THREAD_FILE_DOWNLOAD_CHUNK_BYTES);
const CHANGED = "The download stopped because the file may have changed. Download it again.";
const UPDATE = "Canopy cannot download this file yet. Update Canopy on the computer that holds it, then retry.";

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

function validChunk(file: ui.ThreadFile, offset: bigint, first: ui.ThreadFile): boolean {
  const remaining = first.size - offset;
  const length = remaining < CHUNK_BYTES ? remaining : CHUNK_BYTES;

  return (
    file.resolution === FileResolution.FOUND &&
    !file.truncated &&
    file.path === first.path &&
    file.size === first.size &&
    file.downloadChunk?.offset === offset &&
    file.downloadChunk.revision === first.downloadChunk?.revision &&
    BigInt(file.content.length) === length
  );
}

export const GET: RequestHandler = async ({ params, url, request, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const path = url.searchParams.get("path") ?? "";
  const itemId = url.searchParams.get("itemId") ?? "";

  if (!path.trim() || path.length > 4096 || itemId.length > 1024)
    error(400, "This file path is invalid. Check the path, then retry.");

  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const api = gateway();
  const threadId = params.threadId;

  const first = await api
    .readThreadFile({ threadId, path, itemId, downloadRange: { offset: 0n } }, { signal, timeoutMs: TIMEOUT_MS })
    .catch((cause: unknown) => {
      if (cause instanceof ConnectError) {
        if (cause.code === Code.Unimplemented) error(426, UPDATE);

        if (cause.code === Code.DeadlineExceeded)
          error(504, "The download took too long to start. Check the connection, then retry.");
      }

      failWith(cause);
    });

  if (first.resolution === FileResolution.AMBIGUOUS || first.searchIncomplete)
    error(409, "Canopy could not choose one file. Use the full path.");

  if (first.resolution === FileResolution.NOT_FOUND || first.resolution === FileResolution.DELETED)
    error(404, "Canopy could not find this file. Check its path, then retry.");
  const revision = first.downloadChunk?.revision;

  if (!revision) error(426, UPDATE);

  if (!first.path || !/^[a-f0-9]{64}$/.test(revision) || !validChunk(first, 0n, first)) error(409, CHANGED);

  if (url.searchParams.get("check") === "1") return json({});

  const size = first.size;
  let offset = 0n;

  // Pull only after HTTP asks for bytes. Reuse the first range and keep at most one RPC in flight.
  const body =
    size === 0n || request.method === "HEAD"
      ? null
      : new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const file =
                  offset === 0n
                    ? first
                    : await api.readThreadFile(
                        { threadId, path: first.path, downloadRange: { offset, expectedRevision: revision } },
                        { signal, timeoutMs: TIMEOUT_MS },
                      );

                if (!validChunk(file, offset, first)) throw new Error(CHANGED);
                signal.throwIfAborted();
                offset += BigInt(file.content.length);
                controller.enqueue(file.content);

                if (offset === size) controller.close();
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

  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "content-disposition": fileDisposition(downloadName(first.path)),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
};
