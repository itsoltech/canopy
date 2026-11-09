import type { ui } from "@canopy/contracts";
import { AttachmentPreviewCache, attachmentTextPreview } from "@canopy/domain/attachment-preview";

const cache = new AttachmentPreviewCache();

export const attachmentUrl = (file: ui.Attachment, variant?: "thumbnail" | "download" | "preview" | "image") =>
  `/api/attachments/${encodeURIComponent(file.id)}${variant ? `?${variant}` : ""}`;

export function readAttachmentPreview(file: ui.Attachment) {
  return cache.read(file.id, async () => {
    const response = await fetch(attachmentUrl(file, "preview"));

    if (!response.ok) throw new Error("Could not load preview");
    const data = new Uint8Array(await response.arrayBuffer());

    return attachmentTextPreview(data, file.sizeBytes);
  });
}
