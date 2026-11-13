import sharp from "sharp";
import type { FileContentSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";

/** Inspect raster headers before any client bitmap decode. No SVG/HTML, animation or external path. */
export async function fileImageMetadata(file: MessageInitShape<typeof FileContentSchema>) {
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType ?? "") || file.truncated || !file.content?.length)
    return file;

  try {
    const meta = await sharp(file.content, { limitInputPixels: 16_000_000, pages: 1, animated: false }).metadata();

    if (!meta.width || !meta.height || meta.width * meta.height > 16_000_000)
      return {
        ...file,
        imagePreviewError: "This image exceeds the 16 megapixel preview limit. Open it on the thread’s computer.",
      };

    const preview =
      file.mimeType === "image/gif" || (meta.pages ?? 1) > 1
        ? await sharp(file.content, { limitInputPixels: 16_000_000, pages: 1, animated: false })
            .png()
            .timeout({ seconds: 1 })
            .toBuffer()
        : undefined;

    if (preview && preview.length > 2 * 1024 * 1024)
      return { ...file, imagePreviewError: "This image exceeds the preview limit. Open it on the thread’s computer." };

    return { ...file, imageWidth: meta.width, imageHeight: meta.height, ...(preview && { imagePreview: preview }) };
  } catch {
    return { ...file, imagePreviewError: "This image cannot be previewed safely. Open it on the thread’s computer." };
  }
}
