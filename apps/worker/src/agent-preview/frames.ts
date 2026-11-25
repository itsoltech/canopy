import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import sharp, { type Metadata, type Region, type Sharp } from "sharp";
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

interface WindowGeometry {
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly scaleFactor: number;
}

/** A window screenshot can include an asymmetric translucent shadow around its logical bounds. */
async function windowRegion(image: Sharp, metadata: Metadata, geometry: WindowGeometry): Promise<Region | undefined> {
  const width = Math.round(geometry.windowWidth * geometry.scaleFactor);
  const height = Math.round(geometry.windowHeight * geometry.scaleFactor);
  const { width: imageWidth, height: imageHeight } = metadata;

  if (!width || !height || width > imageWidth || height > imageHeight || (metadata.orientation ?? 1) !== 1)
    return undefined;

  if (width === imageWidth && height === imageHeight) return { left: 0, top: 0, width, height };

  if (!metadata.hasAlpha) return undefined;
  const alpha = await image.clone().extractChannel("alpha").raw({ depth: "uchar" }).toBuffer();
  const first = alpha.indexOf(255);
  const top = Math.floor(first / imageWidth);
  const bottom = Math.floor(alpha.lastIndexOf(255) / imageWidth);

  if (first < 0 || bottom - top + 1 !== height) return undefined;
  let left = imageWidth;
  let right = -1;

  for (let y = top; y <= bottom; y++) {
    const row = alpha.subarray(y * imageWidth, (y + 1) * imageWidth);
    const start = row.indexOf(255);

    if (start < 0) continue;
    left = Math.min(left, start);
    right = Math.max(right, row.lastIndexOf(255));
  }

  return right - left + 1 === width ? { left, top, width, height } : undefined;
}

export async function jpegFrame(data: Uint8Array, window?: WindowGeometry) {
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

  const region = window && (await windowRegion(image, metadata, window));

  if (region && (region.width !== metadata.width || region.height !== metadata.height)) image.extract(region);

  const result = await image
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer({ resolveWithObject: true });

  if (result.data.byteLength > MAX_FRAME_BYTES) throw new Error("Preview frame exceeds 2 MiB");

  return {
    ...(window && { windowAligned: Boolean(region) }),
    data: new Uint8Array(result.data),
    mimeType: "image/jpeg",
    width: result.info.width,
    height: result.info.height,
  };
}
