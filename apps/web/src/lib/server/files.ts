import { error } from "@sveltejs/kit";
import { INLINE_IMAGE_TYPES } from "@canopy/domain";
import { createHash } from "node:crypto";

/**
 * Bytes from the gateway to the browser (docs/ui-api.md, "Załączniki"): only raster images the browser renders
 * safely and sniffed video containers are shown inline; SVG has an explicit image-only path. HTML, text and archives download. The type is the gateway's
 * (from the content), the browser must not guess (`nosniff`), and the document gets no rights at all (CSP sandbox).
 */
export function fileResponse(
  data: Uint8Array,
  mimeType: string,
  options: { name?: string; download?: boolean; image?: boolean; ifNoneMatch?: string | null } = {},
): Response {
  const inline =
    (INLINE_IMAGE_TYPES.has(mimeType) ||
      /^video\/(mp4|webm|quicktime)$/.test(mimeType) ||
      (options.image && mimeType === "image/svg+xml")) &&
    !options.download;

  // A text file read as text, never as markup.
  const type = inline
    ? mimeType
    : mimeType.startsWith("text/")
      ? "text/plain; charset=utf-8"
      : mimeType === "image/svg+xml"
        ? "application/octet-stream"
        : mimeType;

  const name = options.name ?? "attachment";
  // Hash the actual representation: thumbnails and bounded previews have their own bytes and URL keys.
  const etag = `"${createHash("sha256").update(data).digest("hex")}"`;

  const cacheHeaders = {
    "cache-control": "private, max-age=31536000, immutable",
    etag,
    vary: "Cookie, Authorization",
  };

  if (options.ifNoneMatch?.split(",").some((value) => [etag, "*"].includes(value.trim().replace(/^W\//, ""))))
    return new Response(null, { status: 304, headers: cacheHeaders });

  // SAFETY: the bytes come from a decoded gRPC message, whose byte fields are views of ordinary ArrayBuffers
  // (protobuf-es and the Node transport never allocate SharedArrayBuffers).
  return new Response(data as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": type,
      "content-length": String(data.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      // Content never changes under an id or hash; only this user's browser keeps it.
      ...cacheHeaders,
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
