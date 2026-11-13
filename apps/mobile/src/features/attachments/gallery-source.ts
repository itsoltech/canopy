import { create } from "@bufbuild/protobuf";
import { ui, type GalleryImage } from "@canopy/contracts";
import type { ImageSource } from "./image-source";

export function gallerySource(image: GalleryImage): ImageSource {
  return {
    kind: "attachment",
    file: create(ui.AttachmentSchema, {
      id: image.attachmentId,
      name: image.name,
      mimeType: image.mimeType,
      kind: "image",
      sizeBytes: image.sizeBytes,
      width: image.width,
      height: image.height,
      hasThumbnail: image.hasThumbnail,
    }),
  };
}
