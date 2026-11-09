import { AttachmentPreviewCache, attachmentTextPreview } from "@canopy/domain/attachment-preview";
import type { useSession } from "../../state/session";
import type { ui } from "@canopy/contracts";

type Api = NonNullable<ReturnType<typeof useSession>["client"]>["api"];

const caches = new WeakMap<Api, AttachmentPreviewCache>();

export function readAttachmentPreview(api: Api, file: ui.Attachment) {
  let cache = caches.get(api);

  if (!cache) {
    cache = new AttachmentPreviewCache();
    caches.set(api, cache);
  }

  return cache.read(file.id, async () => {
    const response = await api.getAttachment({ attachmentId: file.id, preview: true });

    return attachmentTextPreview(response.data, file.sizeBytes);
  });
}
