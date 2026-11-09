import type { Client } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { ATTACHMENT_PREVIEW_BYTES } from "@canopy/domain/attachment-preview";
import { fileResponse } from "./files.ts";
import { gatewayFailure } from "./gateway-errors.ts";

/** Bytes or a JSON failure for every attachment consumer, including img previews. No payloads enter logs. */
export async function attachmentResponse(api: Client<typeof ui.GatewayService>, attachmentId: string, url: URL) {
  const thumbnail = url.searchParams.has("thumbnail");
  const preview = url.searchParams.has("preview");

  try {
    const response = await api.getAttachment({ attachmentId, thumbnail, preview });
    const name = response.attachment?.name ?? "attachment";
    const data = preview && !thumbnail ? response.data.subarray(0, ATTACHMENT_PREVIEW_BYTES) : response.data;

    const result = fileResponse(data, response.mimeType, {
      name: thumbnail && response.mimeType === "image/webp" ? `${name}.webp` : name,
      download: url.searchParams.has("download"),
      image: url.searchParams.has("image"),
    });

    result.headers.set("x-canopy-preview-truncated", String(response.truncated || data.length < response.data.length));

    return result;
  } catch (cause) {
    const failure = gatewayFailure(cause);
    console.warn("Attachment read failed", {
      method: "GetAttachment",
      variant: thumbnail ? "thumbnail" : preview ? "preview" : "full",
      code: cause instanceof ConnectError ? Code[cause.code] : "Unknown",
      ...failure,
    });

    return Response.json(failure, { status: failure.status, headers: { "cache-control": "no-store" } });
  }
}
