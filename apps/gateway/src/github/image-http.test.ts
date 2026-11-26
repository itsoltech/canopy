import { describe, expect, test } from "bun:test";
import { githubHtmlParts, githubImageUrl } from "@canopy/domain/github-images";
import { Code } from "@connectrpc/connect";
import { imageHttp } from "./image-http.ts";

const asset = "https://github.com/user-attachments/assets/fixture";
const raster = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function gifWithComment(size: number) {
  const gif = Buffer.alloc(size, 0x61);
  raster.copy(gif, 0, 0, raster.length - 1);
  let offset = raster.length - 1;
  gif[offset++] = 0x21;
  gif[offset++] = 0xfe;

  // A GIF comment is split into sub-blocks of up to 255 bytes. Leave two bytes for its terminator and the trailer.
  while (offset < size - 2) {
    const remaining = size - 2 - offset;
    const length = remaining === 257 ? 254 : Math.min(255, remaining - 1);
    gif[offset] = length;
    offset += length + 1;
  }

  gif[offset] = 0;
  gif[offset + 1] = 0x3b;

  return gif;
}

describe("GitHub image trust boundary", () => {
  test("rejects SSRF hosts, credentials, schemes, ports and non-attachment GitHub paths", () => {
    for (const url of [
      "http://github.com/user-attachments/assets/a",
      "https://127.0.0.1/a",
      "https://github.com/api/a",
      "https://github.com.evil.test/user-attachments/assets/a",
      "https://user:pass@github.com/user-attachments/assets/a",
      "https://private-user-images.githubusercontent.com.evil.test/a",
      "https://github.com:444/user-attachments/assets/a",
      "data:image/png;base64,a",
      "https://evil.githubusercontent.com/a",
    ])
      expect(githubImageUrl(url)).toBeUndefined();
    expect(githubImageUrl(asset)).toBe(asset);
  });

  test("parses images and breaks as inert data, drops style/events/tags and decodes text", () => {
    expect(
      githubHtmlParts(
        '<b>Hello &amp; goodbye</b><img src="javascript:alert(1)" width="14px" height="14" style="display:none" onerror="alert(1)"><br><script>untrusted</script>',
      ),
    ).toEqual([
      { kind: "text", text: "Hello & goodbye" },
      { kind: "image", image: { src: "javascript:alert(1)", alt: "", width: 14, height: 14 } },
      { kind: "br" },
      { kind: "text", text: "untrusted" },
    ]);
  });

  test("validates every redirect and keeps credentials off image storage", async () => {
    const seen: { url: string; authenticated: boolean }[] = [];

    const fetcher: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, authenticated: new Headers(init?.headers).has("authorization") });
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("manual");

        return url === asset
          ? new Response(null, {
              status: 302,
              headers: { location: "https://private-user-images.githubusercontent.com/image.gif?jwt=signed" },
            })
          : new Response(raster, { headers: { "content-type": "image/gif" } });
      },
      { preconnect: fetch.preconnect },
    );

    const result = await imageHttp(asset, "", new AbortController().signal, fetcher, "fixture-secret");
    expect(result.value?.dataUrl).toStartWith("data:image/gif;base64,");
    expect(seen.map((r) => r.authenticated)).toEqual([true, false]);

    for (const location of [
      "http://127.0.0.1/a",
      "https://example.test/a",
      "https://private-user-images.githubusercontent.com.evil.test/a",
    ]) {
      let calls = 0;

      const redirect: typeof fetch = Object.assign(
        async () => {
          calls++;

          return new Response(null, { status: 302, headers: { location } });
        },
        { preconnect: fetch.preconnect },
      );

      await expect(imageHttp(asset, "", new AbortController().signal, redirect, "fixture-secret")).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  test("rejects SVG and spoofed raster MIME types", async () => {
    for (const [body, mime] of [
      ["<svg onload='alert(1)'/>", "image/svg+xml"],
      ["<html>unsafe</html>", "image/png"],
    ]) {
      const fetcher: typeof fetch = Object.assign(
        async () => new Response(body, { headers: { "content-type": mime! } }),
        { preconnect: fetch.preconnect },
      );

      await expect(imageHttp(asset, "", new AbortController().signal, fetcher, "fixture-secret")).rejects.toThrow();
    }
  });

  test("accepts a streamed GIF at 2 MiB and cancels a valid GIF one byte over", async () => {
    const limit = 2 * 1024 * 1024;

    for (const size of [limit, limit + 1]) {
      const gif = gifWithComment(size);
      let offset = 0;
      let cancelled = false;

      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset === gif.length) {
              controller.close();

              return;
            }

            const end = Math.min(offset + 64 * 1024, gif.length);
            controller.enqueue(gif.subarray(offset, end));
            offset = end;
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );

      const fetcher: typeof fetch = Object.assign(
        async () => new Response(stream, { headers: { "content-type": "image/gif" } }),
        { preconnect: fetch.preconnect },
      );

      const response = imageHttp(asset, "", new AbortController().signal, fetcher, "fixture-secret");

      if (size === limit) {
        expect((await response).value?.dataUrl).toBe(`data:image/gif;base64,${gif.toString("base64")}`);
        expect(cancelled).toBe(false);
      } else {
        await expect(response).rejects.toMatchObject({
          code: Code.Unavailable,
          rawMessage: "Image unavailable. Open it on GitHub.",
        });
        expect(cancelled).toBe(true);
      }
    }
  });
});
