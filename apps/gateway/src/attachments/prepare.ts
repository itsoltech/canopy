import { createHash } from "node:crypto";
import {
  formatSize,
  safeFileName,
  sniff,
  withExtension,
  type AttachmentKind,
  type AttachmentLimits,
} from "@canopy/domain";
import sharp from "sharp";

/**
 * An uploaded file as the gateway keeps it (docs/ui-api.md, "Załączniki"):
 * - the type comes from the content (sniff), never from the browser's MIME type or the extension,
 * - native programs are refused, everything else is a file,
 * - PNG, JPEG and WebP are re-encoded upright without metadata (EXIF, GPS, XMP), GIF is kept as it is,
 * - HEIC/HEIF, AVIF and TIFF become JPEG or PNG when this build can decode them, else they stay files,
 * - images get a small WebP thumbnail for the UI.
 */

export class AttachmentRejected extends Error {
  override readonly name = "AttachmentRejected";
}

export interface PreparedAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly kind: AttachmentKind;
  readonly data: Uint8Array;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly thumbnail?: { readonly data: Uint8Array; readonly sha256: string };
}

/** Decoded pixels an upload may have (a 10000 x 10000 image); more is refused before decoding. */
const MAX_PIXELS = 100_000_000;
const THUMBNAIL_EDGE = 512;

export const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function prepareAttachment(
  rawName: string,
  data: Uint8Array,
  limits: AttachmentLimits,
): Promise<PreparedAttachment> {
  let name = safeFileName(rawName);

  if (data.length === 0) throw new AttachmentRejected(`${name} is empty`);

  if (data.length > limits.maxFileBytes)
    throw new AttachmentRejected(
      `${name} is ${formatSize(data.length)}; files can be up to ${formatSize(limits.maxFileBytes)}`,
    );
  const sniffed = sniff(data, name);

  if (sniffed.kind === "executable") throw new AttachmentRejected(`${name} is a program; programs cannot be attached`);

  const file = (): PreparedAttachment => ({
    name,
    mimeType: sniffed.mimeType,
    kind: "file",
    data,
    sha256: sha256Hex(data),
  });

  if (sniffed.kind === "file") return file();

  let image: { data: Uint8Array; mimeType: string; width: number; height: number };

  try {
    image = await normalize(data, sniffed.mimeType);
  } catch (error) {
    if (error instanceof AttachmentRejected) throw error;

    // A HEIC this build cannot decode (no HEVC) or a damaged TIFF is still a file; a damaged PNG is not an image.
    if (sniffed.kind === "convertible") return file();
    throw new AttachmentRejected(`${name} could not be read as an image`);
  }

  if (sniffed.kind === "convertible") name = withExtension(name, image.mimeType === "image/png" ? "png" : "jpg");

  const thumbnail = new Uint8Array(
    await sharp(image.data, { limitInputPixels: MAX_PIXELS })
      .resize({ width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer(),
  );

  return {
    name,
    mimeType: image.mimeType,
    kind: "image",
    data: image.data,
    sha256: sha256Hex(image.data),
    width: image.width,
    height: image.height,
    thumbnail: { data: thumbnail, sha256: sha256Hex(thumbnail) },
  };
}

async function normalize(
  data: Uint8Array,
  mimeType: string,
): Promise<{ data: Uint8Array; mimeType: string; width: number; height: number }> {
  const meta = await sharp(data, { limitInputPixels: false }).metadata();
  const width = meta.width ?? 0;
  const height = meta.pageHeight ?? meta.height ?? 0;

  if (width * height > MAX_PIXELS)
    throw new AttachmentRejected(
      `the image is ${Math.round((width * height) / 1e6)} megapixels; up to ${MAX_PIXELS / 1e6} are accepted`,
    );

  // GIF: kept byte for byte (animation; no EXIF to strip).
  if (mimeType === "image/gif") return { data, mimeType, width, height };
  const animated = mimeType === "image/webp" && (meta.pages ?? 1) > 1;
  // rotate(): upright by its EXIF orientation; the output carries no metadata (sharp drops it unless asked).
  const pipeline = sharp(data, { limitInputPixels: MAX_PIXELS, animated }).rotate();

  const encoded =
    mimeType === "image/png" || mimeType === "image/tiff"
      ? pipeline.png()
      : mimeType === "image/webp"
        ? pipeline.webp({ quality: 92 })
        : pipeline.jpeg({ quality: 92, mozjpeg: true });

  const { data: out, info } = await encoded.toBuffer({ resolveWithObject: true });

  const outType =
    mimeType === "image/tiff"
      ? "image/png"
      : mimeType === "image/webp"
        ? "image/webp"
        : mimeType === "image/png"
          ? "image/png"
          : "image/jpeg";

  return { data: new Uint8Array(out), mimeType: outType, width: info.width, height: info.pageHeight ?? info.height };
}
