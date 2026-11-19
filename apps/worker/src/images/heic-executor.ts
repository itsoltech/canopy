import decode from "heic-decode";

declare const self: Worker;

export interface HeicRequest {
  source: Uint8Array;
  page: number;
  maxPixels: number;
}

export type HeicReply = { width: number; height: number; data: Uint8ClampedArray } | { error: string };

self.onmessage = async ({ data }: MessageEvent<HeicRequest>) => {
  try {
    const images = await decode.all({ buffer: data.source });

    try {
      const image = images[data.page];

      if (!image || image.width * image.height > data.maxPixels) throw new Error("invalid HEIC image dimensions");
      const pixels = await image.decode();

      const buffer = pixels.data.buffer;

      self.postMessage(pixels, buffer instanceof ArrayBuffer ? [buffer] : []);
    } finally {
      images.dispose();
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies HeicReply);
  }
};
