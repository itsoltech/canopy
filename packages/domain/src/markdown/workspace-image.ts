import { FileResolution, type ui } from "@canopy/contracts";
import { FILE_PREVIEW_BYTES } from "../workspace-file.ts";

/** Display SVG as an image resource, where scripts and document navigation are disabled. */
export function workspaceImageContent(file: ui.ThreadFile): { bytes: Uint8Array; mimeType: string } | undefined {
  const svg = file.mimeType === "image/svg+xml";

  const raster =
    /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType) &&
    file.imageWidth > 0 &&
    file.imageHeight > 0 &&
    file.imageWidth * file.imageHeight <= 16_000_000;

  const usePreview = !svg && file.imagePreview.length > 0;
  const bytes = usePreview ? file.imagePreview : file.content;

  if (
    (file.resolution !== FileResolution.FOUND && file.resolution !== FileResolution.UNSPECIFIED) ||
    (!svg && !raster) ||
    file.truncated ||
    file.imagePreviewError ||
    file.size > BigInt(FILE_PREVIEW_BYTES) ||
    !bytes.length ||
    bytes.length > FILE_PREVIEW_BYTES
  )
    return;

  return { bytes, mimeType: usePreview ? "image/png" : file.mimeType };
}
