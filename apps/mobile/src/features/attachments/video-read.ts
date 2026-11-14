import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { attachmentRange } from "@canopy/domain";

export interface VideoRequest {
  serverId: string;
  requestId: string;
  method: string;
  range: string;
}

export type VideoWrite = (
  status: number,
  headers: Record<string, string>,
  data: Uint8Array,
  end: boolean,
) => Promise<void>;

export type VideoApi = Pick<Client<typeof ui.GatewayService>, "getAttachment">;

/** Every seek uses owner-scoped reads over the existing pinned, routed client, including linked computers. */
export async function readVideoRequest(
  api: VideoApi,
  attachmentId: string,
  request: VideoRequest,
  write: VideoWrite,
  signal: AbortSignal,
) {
  const meta = await api.getAttachment({ attachmentId, metadataOnly: true }, { signal });
  const size = Number(meta.totalSize);

  if (
    !/^video\/(mp4|webm|quicktime)$/.test(meta.mimeType) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 30 * 1024 ** 2 ||
    meta.data.length
  )
    throw new Error("Update the computer to play this video, or save the file to open it in another app.");
  const header = request.method === "GET" ? request.range : "";
  const range = header ? attachmentRange(header, size) : { start: 0, end: size - 1 };

  const headers = {
    "Content-Type": meta.mimeType,
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": range ? String(range.end - range.start + 1) : "0",
  };

  if (!range) {
    await write(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" }, new Uint8Array(), true);

    return;
  }

  await write(
    header ? 206 : 200,
    header ? { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : headers,
    new Uint8Array(),
    request.method === "HEAD",
  );

  if (request.method === "HEAD") return;

  for (let offset = range.start; offset <= range.end;) {
    signal.throwIfAborted();
    const limit = Math.min(256 * 1024, range.end - offset + 1);
    const response = await api.getAttachment({ attachmentId, offset: BigInt(offset), limit }, { signal });

    if (
      response.offset !== BigInt(offset) ||
      response.totalSize !== meta.totalSize ||
      response.data.length !== limit ||
      response.mimeType !== meta.mimeType
    )
      throw new Error("Could not load the video. Check the connection, then retry.");
    offset += response.data.length;
    await write(0, {}, response.data, offset > range.end);
  }
}
