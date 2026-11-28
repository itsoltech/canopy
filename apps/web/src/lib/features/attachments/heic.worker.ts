import libheif from "libheif-js";
import { MAX_ATTACHMENT_IMAGE_PIXELS } from "@canopy/domain/attachment-preview";

declare const self: Worker;

// Each preview owns its decoder. Terminating this worker also frees its image handles and codec heap.
self.onmessage = async ({ data: source }: MessageEvent<Blob>) => {
  try {
    const images = new libheif.HeifDecoder().decode(new Uint8Array(await source.arrayBuffer()));
    const image = images.find((entry) => entry.is_primary()) ?? images[0];

    if (!image) throw new Error("Missing HEIF image");
    const width = image.get_width();
    const height = image.get_height();

    if (width <= 0 || height <= 0 || width * height > MAX_ATTACHMENT_IMAGE_PIXELS)
      throw new Error("Invalid HEIF dimensions");

    image.display(new ImageData(width, height), (pixels) => {
      self.postMessage(pixels, pixels ? [pixels.data.buffer] : []);
    });
  } catch {
    self.postMessage(null);
  }
};

// The codec invokes its display callback asynchronously.
self.addEventListener("unhandledrejection", () => self.postMessage(null));
