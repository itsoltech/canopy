import { afterEach, describe, expect, test } from "bun:test";
import { ReleaseSource, type ReleaseManifest } from "./release.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("release channels against GitHub fixtures", () => {
  test("selects stable/beta/nightly and stable pins by semver across pages; ignores drafts and unfinished releases", async () => {
    const versions = [
      "v1.9.0",
      "1.10.0",
      "v1.10.2",
      "v2.0.0",
      "v2.1.0-beta.2",
      "v2.1.0-beta.10",
      "v2.1.0-nightly.3",
      "v2.2.0-nightly.1",
    ];

    let newerStable = false;

    const metadata = (tag_name: string) => ({
      tag_name,
      draft: false,
      prerelease: tag_name.includes("-"),
      assets: [{ name: "manifest.json", browser_download_url: `${server.url}manifest/${tag_name}` }],
    });

    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const u = new URL(request.url);

        if (u.pathname === "/releases") {
          const rows = versions.map(metadata);

          return Response.json(
            u.searchParams.get("page") === "1"
              ? [...rows, ...Array.from({ length: 100 - rows.length }, () => metadata("v0.0.1"))]
              : [
                  metadata("v1.10.9"),
                  { ...metadata("v9.0.0"), draft: true },
                  { ...metadata("v8.0.0"), assets: [] },
                  ...(newerStable ? [metadata("v2.2.0")] : []),
                ],
          );
        }

        if (u.pathname.startsWith("/releases/tags/")) {
          const tag = u.pathname.split("/").at(-1)!;

          if (tag === "v1.10.0") return new Response("missing", { status: 404 });

          return Response.json(metadata(tag));
        }

        if (u.pathname.startsWith("/manifest/")) {
          const version = u.pathname.split("/").at(-1)!.replace(/^v/, "");

          return Response.json({
            schema: 1,
            version,
            channel: version.includes("-nightly") ? "nightly" : version.includes("-beta") ? "beta" : "stable",
            commit: "abcdef0",
            published_at: "2026-11-03T00:00:00Z",
            protocol: { worker_link: 1, update: 1 },
            assets: [
              {
                app: "desktop",
                os: "linux",
                arch: "x64",
                name: `Canopy-${version}-linux-x64.AppImage`,
                url: "https://example.com/desktop",
                sha256: "a".repeat(64),
                size: 123,
              },
            ],
          } satisfies ReleaseManifest);
        }

        return new Response("missing", { status: 404 });
      },
    });

    servers.push(server);
    const source = new ReleaseSource({ baseUrl: server.url.href, allowHttpForTests: true, cacheMs: 0 });
    expect((await source.resolve("stable")).version).toBe("2.0.0");
    expect((await source.resolve("latest")).version).toBe("2.0.0");
    expect((await source.resolve("beta")).version).toBe("2.1.0-beta.10");
    expect((await source.resolve("nightly")).version).toBe("2.2.0-nightly.1");
    expect((await source.resolve("v1")).version).toBe("1.10.9");
    expect((await source.resolve("v1.10")).version).toBe("1.10.9");
    expect((await source.resolve("v1.9.0")).version).toBe("1.9.0");
    expect((await source.resolve("v1.10.0")).version).toBe("1.10.0");
    expect((await source.version("2.1.0-beta.2")).version).toBe("2.1.0-beta.2");
    await expect(source.resolve("v3")).rejects.toThrow("No release");
    await expect(source.resolve("v2.1.0-beta.2")).rejects.toThrow("Use stable");
    newerStable = true;

    for (const channel of ["stable", "beta", "nightly"]) expect((await source.resolve(channel)).version).toBe("2.2.0");
  });
  test("rejects insecure sources, redirects, tag/manifest mismatches and prereleases disguised as stable pins", async () => {
    expect(() => new ReleaseSource({ baseUrl: "http://example.com" })).toThrow("HTTPS");

    const source = new ReleaseSource({
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://example.com/release" } }),
    });

    await expect(source.resolve("stable")).rejects.toThrow("HTTPS");

    const mismatch = new ReleaseSource({
      indexUrl: false,
      fetch: async (input) =>
        Response.json(
          String(input).includes("/releases/")
            ? {
                tag_name: "1.2.3",
                assets: [{ name: "manifest.json", browser_download_url: "https://example.com/manifest" }],
              }
            : {
                schema: 1,
                version: "9.0.0",
                channel: "stable",
                commit: "a",
                published_at: "now",
                protocol: { worker_link: 1, update: 1 },
                assets: [],
              },
        ),
    });

    await expect(mismatch.resolve("v1.2.3")).rejects.toThrow("differ");

    const disguised = new ReleaseSource({
      indexUrl: false,
      fetch: async () => Response.json({ tag_name: "v1.2.3", prerelease: true, assets: [] }),
    });

    await expect(disguised.resolve("v1.2.3")).rejects.toThrow("No release");
  });
});
