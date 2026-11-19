import { isStandalone } from "@canopy/updater";
import sharp, { type Metadata } from "sharp";
import type { HeicReply, HeicRequest } from "./heic-executor.ts";

/** Decode off the WorkerLink event loop and release the WASM heap after each photo. */
export async function heicImage(source: Uint8Array, meta: Metadata, maxPixels: number) {
  // In the standalone binary Bun resolves URLs from the bundled main entry.
  const entry = isStandalone() ? "./images/heic-executor.js" : "./heic-executor.ts";
  const worker = new Worker(new URL(entry, import.meta.url));

  try {
    const pixels = await new Promise<HeicReply>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<HeicReply>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ source, page: meta.pagePrimary ?? 0, maxPixels } satisfies HeicRequest);
    });

    if ("error" in pixels) throw new Error(pixels.error);
    const image = sharp(pixels.data, { raw: { width: pixels.width, height: pixels.height, channels: 4 } });

    if (!meta.hasAlpha) image.removeAlpha();

    // libheif applies HEIF container transforms. Raw pixels no longer carry a separate EXIF orientation.
    switch (meta.orientation) {
      case 2:
        return image.flop();
      case 3:
        return image.rotate(180);
      case 4:
        return image.flip();
      case 5:
        return image.flop().rotate(270);
      case 6:
        return image.rotate(90);
      case 7:
        return image.flop().rotate(90);
      case 8:
        return image.rotate(270);
      default:
        return image;
    }
  } finally {
    worker.terminate();
  }
}
