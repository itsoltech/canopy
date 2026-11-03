import { afterEach, describe, expect, test } from "bun:test";
import { ReleaseSource, type ReleaseManifest } from "./release.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

describe("release channels against GitHub fixtures", () => {
  test("resolves rolling, exact, major and minor channels; sorts semver and paginates", async () => {
    const versions = ["v1.9.0", "1.10.0", "v1.10.2", "v2.0.0", "v1.11.0-beta.1"];
    const metadata = (tag_name: string) => ({ tag_name, draft: false, prerelease: tag_name.includes("beta") || tag_name === "latest", assets: [{ name: "manifest.json", browser_download_url: `${server.url}manifest/${tag_name}` }] });
    const server = Bun.serve({ port: 0, fetch(request): Response {
      const u = new URL(request.url);
      if (u.pathname === "/releases") {
        const rows = versions.map(metadata);
        // A full first page must not hide the highest minor version on the next page.
        return Response.json(u.searchParams.get("page") === "1" ? [...rows, ...Array.from({ length: 95 }, () => metadata("v0.0.1"))] : [metadata("v1.10.9")]);
      }
      if (u.pathname.startsWith("/releases/tags/")) return Response.json(metadata(u.pathname.split("/").at(-1)!));
      if (u.pathname.startsWith("/manifest/")) {
        const tag = u.pathname.split("/").at(-1)!;
        const version = tag.replace(/^v/, "");
        return Response.json({ schema: 1, version: tag === "latest" ? "2.1.0-main.abcdef0" : version,
          channel: tag === "latest" ? "latest" : `v${version}`, commit: "abcdef0", published_at: "2026-11-03T00:00:00Z", protocol: { worker_link: 1, update: 1 },
          assets: [{ app: "desktop", os: "linux", arch: "x64", name: "Canopy-1.10.9-linux-x64.AppImage", url: "https://example.com/desktop", sha256: "a".repeat(64), size: 123 }] } satisfies ReleaseManifest);
      }
      return new Response("missing", { status: 404 });
    } }); servers.push(server);
    const source = new ReleaseSource({ baseUrl: server.url.href, allowHttpForTests: true });
    expect((await source.resolve("latest")).version).toBe("2.1.0-main.abcdef0");
    expect((await source.resolve("v1")).version).toBe("1.10.9");
    expect((await source.resolve("v1.10")).version).toBe("1.10.9");
    expect((await source.resolve("v1.9.0")).version).toBe("1.9.0");
    await expect(source.resolve("v3")).rejects.toThrow("No release");
    await expect(source.version("2.0.0-main.1234567")).rejects.toThrow("no longer published");
  });
  test("rejects insecure sources, insecure redirects, tag/manifest mismatches and malformed assets", async () => {
    expect(() => new ReleaseSource({ baseUrl: "http://example.com" })).toThrow("HTTPS");
    const source = new ReleaseSource({ fetch: async () => new Response(null, { status: 302, headers: { location: "http://example.com/release" } }) });
    await expect(source.resolve("latest")).rejects.toThrow("HTTPS");
    const mismatch = new ReleaseSource({ fetch: async (input) => Response.json(String(input).includes("/releases/") ?
      { tag_name: "1.2.3", assets: [{ name: "manifest.json", browser_download_url: "https://example.com/manifest" }] } :
      { schema: 1, version: "9.0.0", channel: "v9", commit: "a", published_at: "now", protocol: { worker_link: 1, update: 1 }, assets: [] }) });
    await expect(mismatch.resolve("v1.2.3")).rejects.toThrow("differ");
  });
});
