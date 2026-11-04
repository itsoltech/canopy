import { fileResponse } from "#lib/server/files.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

/** An attachment's bytes (`?thumbnail` = an image's WebP thumbnail, `?download` = always as a download); owner only. */
export const GET: RequestHandler = async ({ params, url }) => {
  const thumbnail = url.searchParams.has("thumbnail");
  const response = await call((api) => api.getAttachment({ attachmentId: params.attachmentId, thumbnail }));
  const name = response.attachment?.name ?? "attachment";

  return fileResponse(response.data, response.mimeType, {
    name: thumbnail ? `${name}.webp` : name,
    download: url.searchParams.has("download"),
  });
};
