import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import sharp from "sharp";

export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Check the opened regular file before allocating; bounded reads also defend against a growing file. */
export async function readAgentToolScreenshot(path: string): Promise<Uint8Array> {
  const entry = lstatSync(path);

  if (!entry.isFile()) throw new Error("Screenshot is not a regular PNG file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let source: Buffer;

  try {
    const stat = fstatSync(fd);

    // The identity check also protects platforms where O_NOFOLLOW is unavailable.
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("Screenshot changed before being opened");

    if (!stat.isFile() || stat.size < PNG_SIGNATURE.length) throw new Error("Screenshot is not a PNG file");

    if (stat.size > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot is larger than 4 MiB");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    let count: number;

    while (bytes < buffer.length && (count = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0)
      bytes += count;

    if (bytes !== stat.size) throw new Error("Screenshot changed while being read");
    source = buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }

  if (!source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("Screenshot is not a PNG file");
  const image = sharp(source, { limitInputPixels: 32_000_000, failOn: "warning", animated: false });
  const metadata = await image.metadata();

  if (metadata.format !== "png" || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1)
    throw new Error("Screenshot is not a single PNG image");

  const data = await image
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  if (data.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("Normalized screenshot is larger than 4 MiB");

  return new Uint8Array(data);
}
