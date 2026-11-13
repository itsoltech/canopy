import { Code, ConnectError } from "@connectrpc/connect";
import { githubImageUrl } from "@canopy/domain/github-images";

const unavailable = () => new ConnectError("Image unavailable. Open it on GitHub.", Code.Unavailable);
const limit = 2 * 1024 * 1024;

/** Raster signatures prevent HTML/SVG disguised with an image Content-Type. */
function raster(bytes: Buffer, mime: string) {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;

  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString());

  if (mime === "image/webp")
    return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";

  return false;
}

export async function imageHttp(
  source: string,
  etag: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  token: string,
) {
  let url = githubImageUrl(source);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

  for (let redirects = 0; url && redirects <= 4; redirects++) {
    const requestHeaders = new Headers({ Accept: "image/png,image/jpeg,image/gif,image/webp" });

    if (new URL(url).hostname === "github.com") requestHeaders.set("Authorization", `Bearer ${token}`);

    if (etag) requestHeaders.set("If-None-Match", etag);

    const response = await fetcher(url, {
      redirect: "manual",
      credentials: "omit",
      signal: bounded,
      headers: requestHeaders,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      url = location ? githubImageUrl(new URL(location, url).href) : undefined;
      continue;
    }

    // Never cache or expose redirect locations, cookies, signed URLs or arbitrary response headers.
    const headers = new Headers();
    const validator = response.headers.get("etag");

    if (validator) headers.set("etag", validator);

    if (response.status === 304) return { status: 304, headers, value: null };
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const reader = response.body?.getReader();

    if (!response.ok || !reader || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
      await reader?.cancel();
      throw unavailable();
    }

    let size = 0;
    const parts: Uint8Array[] = [];

    try {
      for (;;) {
        const part = await reader.read();

        if (part.done) break;
        size += part.value.byteLength;

        if (size > limit) throw unavailable();
        parts.push(part.value);
      }
    } finally {
      await reader.cancel();
    }

    const bytes = Buffer.concat(parts);

    if (!raster(bytes, mime)) throw unavailable();

    return { status: response.status, headers, value: { dataUrl: `data:${mime};base64,${bytes.toString("base64")}` } };
  }

  throw unavailable();
}
