import { fileResponse } from "#lib/server/files.ts";
import { call } from "#lib/server/gateway.ts";
import { ATTACHMENT_PREVIEW_BYTES } from "@canopy/domain/attachment-preview";
import type { RequestHandler } from "./$types";

/** An attachment's bytes (`?thumbnail` = an image's WebP thumbnail, `?download` = always as a download); owner only. */
export const GET: RequestHandler = async ({ params, url }) => {
  const thumbnail = url.searchParams.has("thumbnail");
  const preview = url.searchParams.has("preview");
  const response = await call((api) => api.getAttachment({ attachmentId: params.attachmentId, thumbnail, preview }));
  const name = response.attachment?.name ?? "attachment";

  const data = preview && !thumbnail ? response.data.subarray(0, ATTACHMENT_PREVIEW_BYTES) : response.data;

  const result = fileResponse(data, response.mimeType, {
    name: thumbnail ? `${name}.webp` : name,
    download: url.searchParams.has("download"),
    image: url.searchParams.has("image"),
  });

  result.headers.set("x-canopy-preview-truncated", String(response.truncated));

  return result;
};
