import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { fileResponse } from "./files.ts";
import { attachmentRange } from "@canopy/domain";

const CHUNK_BYTES = 256 * 1024;

/** Backpressure reaches PostgreSQL: at most one bounded RPC is in flight, including for linked homes. */
export async function attachmentStream(
  api: Pick<Client<typeof ui.GatewayService>, "getAttachment">,
  attachmentId: string,
  url: URL,
  request: Request,
) {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const meta = await api.getAttachment({ attachmentId, metadataOnly: true }, { signal });
  const size = Number(meta.totalSize || BigInt(meta.data.length));

  if (!meta.attachment || !Number.isSafeInteger(size) || size > 30 * 1024 ** 2)
    throw new Error("Attachment metadata unavailable");
  const etag = `"${meta.attachment?.sha256}"`;

  const headers = fileResponse(new Uint8Array(), meta.mimeType, {
    name: meta.attachment?.name ?? "attachment",
    download: url.searchParams.has("download"),
  }).headers;

  headers.set("etag", etag);
  headers.set("accept-ranges", "bytes");

  if (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some((value) => [etag, "*"].includes(value.trim().replace(/^W\//, "")))
  ) {
    headers.delete("content-length");

    return new Response(null, { status: 304, headers });
  }

  const ifRange = request.headers.get("if-range");
  const rangeHeader = request.method === "GET" && (!ifRange || ifRange === etag) ? request.headers.get("range") : null;
  const range = rangeHeader ? attachmentRange(rangeHeader, size) : { start: 0, end: size - 1 };

  if (!range) {
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");
    headers.set("cache-control", "no-store");

    return new Response(null, { status: 416, headers });
  }

  const { start, end } = range;
  headers.set("content-length", String(end - start + 1));

  if (rangeHeader) headers.set("content-range", `bytes ${start}-${end}/${size}`);

  let offset = start;

  const body =
    request.method === "HEAD"
      ? null
      : new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                if (offset > end) {
                  controller.close();

                  return;
                }

                const limit = Math.min(CHUNK_BYTES, end - offset + 1);

                // Old homes ignore the additive metadata/range fields: reuse their bounded-by-upload full response once.
                const response =
                  meta.totalSize === 0n
                    ? meta
                    : await api.getAttachment({ attachmentId, offset: BigInt(offset), limit }, { signal });

                const data = response.totalSize === 0n ? response.data.subarray(offset, offset + limit) : response.data;

                if (
                  data.length !== limit ||
                  (response.totalSize !== 0n &&
                    (response.offset !== BigInt(offset) || response.totalSize !== BigInt(size)))
                )
                  throw new Error("Attachment byte range unavailable");
                offset += data.length;
                controller.enqueue(data);
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

  return new Response(body, { status: rangeHeader ? 206 : 200, headers });
}
