import { describe, expect, test } from "bun:test";
import { githubHtmlParts, githubImageUrl } from "@canopy/domain/github-images";
import { imageHttp } from "./image-http.ts";

const asset = "https://github.com/user-attachments/assets/fixture";
const raster = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");

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

  test("rejects SVG, spoofed raster MIME types and oversized streamed bodies", async () => {
    for (const [body, mime] of [
      ["<svg onload='alert(1)'/>", "image/svg+xml"],
      ["<html>unsafe</html>", "image/png"],
      ["x".repeat(2 * 1024 * 1024 + 1), "image/gif"],
    ]) {
      const fetcher: typeof fetch = Object.assign(
        async () => new Response(body, { headers: { "content-type": mime! } }),
        { preconnect: fetch.preconnect },
      );

      await expect(imageHttp(asset, "", new AbortController().signal, fetcher, "fixture-secret")).rejects.toThrow();
    }
  });
});
