import type { ui } from "@canopy/contracts";
import { FILE_PREVIEW_BYTES } from "@canopy/domain/workspace-file";
import { fileResponse } from "./files.ts";

/** Keep even a separately opened workspace SVG inside the HTTP response's document sandbox. */
export function workspaceImageResponse(file: ui.ThreadFile): Response {
  const svg = file.mimeType === "image/svg+xml";

  const raster =
    /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType) &&
    file.imageWidth > 0 &&
    file.imageHeight > 0 &&
    file.imageWidth * file.imageHeight <= 16_000_000;

  const usePreview = !svg && file.imagePreview.length > 0;
  const bytes = usePreview ? file.imagePreview : file.content;

  if (
    (!svg && !raster) ||
    file.truncated ||
    file.imagePreviewError ||
    file.size > BigInt(FILE_PREVIEW_BYTES) ||
    !bytes.length ||
    bytes.length > FILE_PREVIEW_BYTES
  )
    return new Response("This image cannot be previewed.", { status: 415, headers: { "cache-control": "no-store" } });

  const response = fileResponse(bytes, usePreview ? "image/png" : file.mimeType, { image: true, mutable: true });
  response.headers.set("content-disposition", "inline");

  return response;
}
