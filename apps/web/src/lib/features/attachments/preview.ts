import type { ui } from "@canopy/contracts";
import { AttachmentPreviewCache, attachmentTextPreview } from "@canopy/domain/attachment-preview";
import { bodyJson, isJsonObject, isString } from "#lib/shared/json.ts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { splitId } from "@canopy/domain/computers";

const cache = new AttachmentPreviewCache();

export const attachmentUrl = (file: ui.Attachment, variant?: "thumbnail" | "download" | "preview" | "image") =>
  `/api/attachments/${encodeURIComponent(file.id)}${variant ? `?${variant}` : ""}`;

/** Track the home's presence and gateway reconnections, so mounted failed previews can recover. */
export function attachmentConnection(id: () => string) {
  const overview = useOverview();

  return () => {
    const node = splitId(id()).node;
    const peer = node && [...(overview?.computers.values() ?? [])].find((computer) => computer.nodeId.startsWith(node));

    return `${overview?.resyncs ?? 0}:${peer ? peer.status : ""}`;
  };
}

export async function previewResponse(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal });

  if (!response.ok) {
    const payload = await bodyJson(response).catch(() => null);
    const message = isJsonObject(payload) ? payload["message"] : undefined;
    throw new Error(isString(message) ? message : `Could not load the preview (${response.status}).`);
  }

  return response;
}

export function readAttachmentPreview(file: ui.Attachment) {
  return cache.read(file.id, async () => {
    const response = await previewResponse(attachmentUrl(file, "preview"));
    const data = new Uint8Array(await response.arrayBuffer());

    return attachmentTextPreview(data, file.sizeBytes);
  });
}
