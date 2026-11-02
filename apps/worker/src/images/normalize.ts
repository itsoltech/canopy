import sharp, { type Metadata } from "sharp";

/**
 * Images for models and for the transcript (docs/agent-bus.md, "view_image"): decoded from whatever the device has
 * (PNG, JPEG, GIF, WebP, AVIF, TIFF, HEIC where this build decodes it), turned upright, scaled to at most
 * MAX_EDGE on the long edge, re-encoded without metadata (EXIF, GPS) and kept under a byte cap every provider takes
 * (Claude: 5 MB base64). PNG for images with transparency, JPEG for the rest; WebP previews for the transcript.
 */

export const MAX_EDGE = 2000;
/** Raw bytes of an image for a model: ~3.75 MB stays under 5 MB once base64-encoded. */
export const MAX_MODEL_BYTES = 3_750_000;
/** Largest file view_image or a preview reads. */
export const MAX_SOURCE_BYTES = 50 * 1024 ** 2;
const MAX_PIXELS = 268_402_689;

export interface NormalizedImage {
  readonly data: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

export class ImageError extends Error {
  override readonly name = "ImageError";
}

/** An image a model can take: at most MAX_EDGE px, under MAX_MODEL_BYTES (smaller sizes until it fits). */
export async function forModel(source: Uint8Array): Promise<NormalizedImage> {
  const meta = await metadata(source);
  const alpha = meta.hasAlpha === true;
  for (const edge of [MAX_EDGE, 1600, 1200, 800]) {
    const image = sharp(source, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    const encoded = alpha ? image.png({ compressionLevel: 9, palette: edge < MAX_EDGE }) : image.jpeg({ quality: 85, mozjpeg: true });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    if (data.length <= MAX_MODEL_BYTES || edge === 800) {
      return { data: new Uint8Array(data), mimeType: alpha ? "image/png" : "image/jpeg", width: info.width, height: info.height, ...original(meta) };
    }
  }
  throw new ImageError("the image could not be made small enough");
}

/** A transcript preview (WebP, at most MAX_EDGE px) of an image the agent looked at. */
export async function forTranscript(source: Uint8Array): Promise<NormalizedImage> {
  const meta = await metadata(source);
  const { data, info } = await sharp(source, { limitInputPixels: MAX_PIXELS, animated: false })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), mimeType: "image/webp", width: info.width, height: info.height, ...original(meta) };
}

async function metadata(source: Uint8Array) {
  try {
    const meta = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
    if (!meta.width || !meta.height) throw new ImageError("the file has no image dimensions");
    return meta;
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError(`not an image this worker can read (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Dimensions as the image is meant to be seen (EXIF orientation 5-8 swaps them). */
function original(meta: Metadata): { originalWidth: number; originalHeight: number } {
  const width = meta.width ?? 0;
  const height = meta.pageHeight ?? meta.height ?? 0;
  return (meta.orientation ?? 1) >= 5 ? { originalWidth: height, originalHeight: width } : { originalWidth: width, originalHeight: height };
}
