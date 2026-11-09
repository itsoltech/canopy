import { fileResponse } from "#lib/server/files.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

/** A preview of an image the agent looked at (Image.blob, ToolCall.images), through the thread that shows it. */
export const GET: RequestHandler = async ({ params, url, request }) => {
  const response = await call((api) => api.getThreadBlob({ threadId: params.threadId, sha256: params.sha256 }));
  const ext = response.mimeType.split("/")[1] ?? "img";

  return fileResponse(response.data, response.mimeType, {
    name: `image-${params.sha256.slice(0, 12)}.${ext}`,
    download: url.searchParams.has("download"),
    ifNoneMatch: request.headers.get("if-none-match"),
  });
};
