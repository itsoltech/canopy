import type { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";

export type ImageSource =
  | { kind: "thread"; threadId: string; sha256: string; sizeBytes: bigint }
  | { kind: "attachment"; file: ui.Attachment }
  | { kind: "local"; uri: string };

export const IMAGE_BYTES = 20 * 1024 ** 2;
export const rasterImage = /^image\/(png|jpeg|gif|webp)$/i;

export class ImageReadError extends Error {}

/** Preserve qualified computer ids and key the actual representation, including full-only blob fallbacks. */
export function imageCacheKey(source: Exclude<ImageSource, { kind: "local" }>, thumbnail: boolean) {
  return JSON.stringify(
    source.kind === "attachment"
      ? ["attachment", source.file.id, thumbnail && source.file.hasThumbnail ? "thumbnail" : "full"]
      : ["blob", source.threadId, source.sha256, "full"],
  );
}

export async function readImage(
  api: Pick<Client<typeof ui.GatewayService>, "getThreadBlob" | "getAttachment">,
  source: Exclude<ImageSource, { kind: "local" }>,
  thumbnail: boolean,
  signal: AbortSignal,
) {
  const size = source.kind === "thread" ? source.sizeBytes : source.file.sizeBytes;

  if (size > BigInt(IMAGE_BYTES))
    throw new ImageReadError("This image exceeds the 20 MB viewing limit. Export a smaller image to view it.");

  const response =
    source.kind === "thread"
      ? await api.getThreadBlob({ threadId: source.threadId, sha256: source.sha256 }, { signal })
      : await api.getAttachment(
          { attachmentId: source.file.id, thumbnail: thumbnail && source.file.hasThumbnail },
          { signal },
        );

  if (!rasterImage.test(response.mimeType) || response.data.length > IMAGE_BYTES)
    throw new ImageReadError("This file cannot be shown as an image. Attach a PNG, JPEG, GIF or WebP image.");

  return response;
}
