import type { ui } from "@canopy/contracts";
import { workspaceImageContent } from "@canopy/domain/markdown-workspace-image";
import { fileResponse } from "./files.ts";

/** Keep even a separately opened workspace SVG inside the HTTP response's document sandbox. */
export function workspaceImageResponse(file: ui.ThreadFile): Response {
  const image = workspaceImageContent(file);

  if (!image)
    return new Response("This image cannot be previewed.", { status: 415, headers: { "cache-control": "no-store" } });

  const response = fileResponse(image.bytes, image.mimeType, { image: true, mutable: true });
  response.headers.set("content-disposition", "inline");

  return response;
}
