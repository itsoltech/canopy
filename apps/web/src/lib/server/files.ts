import { error } from "@sveltejs/kit";
import { INLINE_IMAGE_TYPES } from "@canopy/domain";

/**
 * Bytes from the gateway to the browser (docs/ui-api.md, "Załączniki"): only raster images the browser renders
 * safely are shown inline; everything else (SVG, HTML, text, archives) is a download. The type is the gateway's
 * (from the content), the browser must not guess (`nosniff`), and the document gets no rights at all (CSP sandbox).
 */
export function fileResponse(
  data: Uint8Array,
  mimeType: string,
  options: { name?: string; download?: boolean } = {},
): Response {
  const inline = INLINE_IMAGE_TYPES.has(mimeType) && !options.download;

  // A text file read as text, never as markup.
  const type = inline
    ? mimeType
    : mimeType.startsWith("text/")
      ? "text/plain; charset=utf-8"
      : mimeType === "image/svg+xml"
        ? "application/octet-stream"
        : mimeType;

  const name = options.name ?? "attachment";

  return new Response(data as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": type,
      "content-length": String(data.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      // Content never changes under an id or hash; only this user's browser keeps it.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

/**
 * Requests that only a page of this app can make: the custom header needs a CORS preflight, which a cross-site
 * page does not get, and a sent Origin must name this host. The scheme is not compared: behind a proxy without
 * PROTOCOL_HEADER adapter-node assumes https.
 */
export function requireSameOrigin(request: Request, url: URL): void {
  if (request.headers.get("x-requested-with") !== "canopy") error(403, "Missing request header");
  const origin = request.headers.get("origin");
  let host: string | undefined;

  try {
    host = origin === null ? url.host : new URL(origin).host;
  } catch {
    host = undefined;
  }

  if (host !== url.host) error(403, "Cross-origin request");
}
