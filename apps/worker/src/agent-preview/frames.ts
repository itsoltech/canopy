import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import sharp from "sharp";
import { MAX_FRAME_BYTES, MAX_IMAGE_BYTES } from "./types.ts";

export function readPreviewImage(path: string): Uint8Array {
  const entry = lstatSync(path);

  if (!entry.isFile() || entry.size > MAX_IMAGE_BYTES) throw new Error("Preview image is not a bounded regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size > MAX_IMAGE_BYTES)
      throw new Error("Preview image changed before being opened");
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    let count: number;

    while (size < data.length && (count = readSync(fd, data, size, data.length - size, null)) > 0) size += count;

    if (size !== stat.size) throw new Error("Preview image changed while being read");

    return data.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

export async function jpegFrame(data: Uint8Array) {
  if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES) throw new Error("Preview image exceeds its input limit");
  const image = sharp(data, { limitInputPixels: 32_000_000, failOn: "warning", animated: false });
  const metadata = await image.metadata();

  if (
    !["png", "jpeg"].includes(metadata.format ?? "") ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > 8192 ||
    metadata.height > 8192 ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error("Preview is not a supported bounded image");

  const result = await image
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer({ resolveWithObject: true });

  if (result.data.byteLength > MAX_FRAME_BYTES) throw new Error("Preview frame exceeds 2 MiB");

  return {
    data: new Uint8Array(result.data),
    mimeType: "image/jpeg",
    width: result.info.width,
    height: result.info.height,
  };
}
