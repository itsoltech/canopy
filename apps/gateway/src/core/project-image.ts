import { sniff } from "@canopy/domain";
import sharp from "sharp";
import { Invalid } from "../store/errors.ts";

const MAX_UPLOAD_BYTES = 10 * 1024 ** 2;
const MAX_INPUT_PIXELS = 4096 ** 2;
const EDGE = 128;
const MAX_BASE64_BYTES = 24 * 1024;
const FORMATS = new Set(["image/png", "image/jpeg", "image/webp"]);

// PNG signature and IHDR for a non-interlaced 128×128 indexed PNG with 8-bit palette indices.
const PNG_HEADER = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5";
const PNG_CHUNKS = new Set(["PLTE", "tRNS", "pHYs", "IDAT"]);

export async function normalizeProjectImage(image: Uint8Array): Promise<string> {
  if (!image.length) return "";

  if (image.length > MAX_UPLOAD_BYTES) throw new Invalid("Choose an image up to 10 MiB.");

  if (!FORMATS.has(sniff(image).mimeType)) throw new Invalid("Choose a PNG, JPEG, or WebP image.");

  try {
    const decoder = sharp(image, { limitInputPixels: MAX_INPUT_PIXELS });
    const { format, width, height } = await decoder.metadata();

    if (!format || !FORMATS.has(`image/${format}`)) throw new Invalid("Choose a PNG, JPEG, or WebP image.");

    if (!width || width !== height) throw new Invalid("Crop the project image to a square.");

    // Start the encoder from pixels so source density, color profiles and other metadata cannot carry over.
    const pixels = await decoder.autoOrient().resize(EDGE, EDGE).toColourspace("srgb").ensureAlpha().raw().toBuffer();

    const thumbnail = await sharp(pixels, { raw: { width: EDGE, height: EDGE, channels: 4 } })
      .png({ palette: true, colours: 256, compressionLevel: 9 })
      .toBuffer();

    const encoded = thumbnail.toString("base64");

    if (encoded.length > MAX_BASE64_BYTES) throw new Invalid("The project image could not be resized.");

    return encoded;
  } catch (error) {
    if (error instanceof Invalid) throw error;
    throw new Invalid("The project image could not be read.");
  }
}

/** Linked computers send the normalized thumbnail in the versioned project field. */
export async function isProjectImage(image: string): Promise<boolean> {
  if (!image) return true;

  if (image.length > MAX_BASE64_BYTES || !image.startsWith(PNG_HEADER)) return false;
  const png = Buffer.from(image, "base64");

  if (png.toString("base64") !== image) return false;

  for (let offset = 33; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    offset += length + 12;

    if (type === "IEND" && length === 0 && offset === png.length) {
      // Reading the full raster also rejects corrupt image data with a well-formed header.
      return sharp(png, { limitInputPixels: EDGE ** 2 })
        .raw()
        .toBuffer()
        .then(
          () => true,
          () => false,
        );
    }

    if (!PNG_CHUNKS.has(type)) return false;
  }

  return false;
}
