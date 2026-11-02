import { describe, expect, test } from "bun:test";
import { fileResponse } from "../src/lib/server/files.ts";

/** Bytes the BFF serves (docs/ui-api.md, "Załączniki"): only safe raster images inline, the rest downloads. */
describe("attachment responses", () => {
  const headers = (mimeType: string, options?: { name?: string; download?: boolean }) => fileResponse(new Uint8Array([1, 2, 3]), mimeType, options).headers;

  test("raster images inline, with the gateway's type, no sniffing and no rights", () => {
    const h = headers("image/png", { name: "shot.png" });
    expect(h.get("content-type")).toBe("image/png");
    expect(h.get("content-disposition")).toStartWith("inline;");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(h.get("cache-control")).toStartWith("private");
  });

  test("SVG and HTML are downloads, never markup the browser renders", () => {
    const svg = headers("image/svg+xml", { name: "logo.svg" });
    expect(svg.get("content-type")).toBe("application/octet-stream");
    expect(svg.get("content-disposition")).toStartWith("attachment;");
    const html = headers("text/html", { name: "page.html" });
    expect(html.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(html.get("content-disposition")).toStartWith("attachment;");
  });

  test("a download of an image, and names that cannot break the header", () => {
    expect(headers("image/jpeg", { download: true }).get("content-disposition")).toStartWith("attachment;");
    const odd = headers("text/plain", { name: 'a"b\\cż.txt' }).get("content-disposition") ?? "";
    expect(odd).toContain('filename="a_b_c_.txt"');
    expect(odd).toContain("filename*=UTF-8''a%22b%5Cc%C5%BC.txt");
  });
});
