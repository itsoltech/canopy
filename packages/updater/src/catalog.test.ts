import { expect, test } from "bun:test";
import { ReleaseCatalog, parseReleaseIndex, RELEASE_INDEX_URL, RELEASE_API_URL } from "@canopy/domain/release/catalog";
import { ReleaseHttp, ReleaseRateLimit, RELEASE_CACHE_MS } from "@canopy/domain/release/http";
import { ReleaseSource, type ReleaseManifest } from "./release.ts";

const release = {
  tag_name: "v1.2.3",
  draft: false,
  prerelease: false,
  published_at: "2026-11-10T09:00:00Z",
  body: "Release notes",
  assets: [
    {
      name: "manifest.json",
      browser_download_url: "https://github.com/itsoltech/canopy/releases/download/v1.2.3/manifest.json",
    },
  ],
};

const index = JSON.stringify({ schema: 1, releases: [release] });

const manifest: ReleaseManifest = {
  schema: 1,
  version: "1.2.3",
  channel: "stable",
  commit: "abcdef0",
  published_at: release.published_at,
  protocol: { worker_link: 1, update: 1 },
  assets: [],
};

test("the versioned index rejects drafts, missing manifests, duplicate tags, unsafe URLs and unknown schemas", () => {
  expect(parseReleaseIndex(index)[0]).toEqual(release);

  for (const releases of [
    [{ ...release, draft: true }],
    [{ ...release, published_at: "not a date" }],
    [{ ...release, assets: [] }],
    [release, release],
    [{ ...release, assets: [{ name: "manifest.json", browser_download_url: "http://example.com/file" }] }],
  ])
    expect(() => parseReleaseIndex(JSON.stringify({ schema: 1, releases }))).toThrow();
  expect(() => parseReleaseIndex(JSON.stringify({ schema: 2, releases: [release] }))).toThrow();
});

test("channel and exact resolutions use the index, dedupe immutable manifests, and still reject a mismatched manifest", async () => {
  const urls: string[] = [];

  const source = new ReleaseSource({
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);

      return url === RELEASE_INDEX_URL ? new Response(index) : Response.json(manifest);
    },
  });

  expect((await source.resolve("stable")).version).toBe("1.2.3");
  expect((await source.version("1.2.3")).version).toBe("1.2.3");
  await expect(source.version("9.0.0")).rejects.toThrow("No release");
  expect(urls).toEqual([RELEASE_INDEX_URL, release.assets[0]!.browser_download_url]);

  const wrong = new ReleaseSource({
    fetch: async (input) =>
      String(input) === RELEASE_INDEX_URL ? new Response(index) : Response.json({ ...manifest, version: "9.0.0" }),
  });

  await expect(wrong.resolve("stable")).rejects.toThrow("Release tag and manifest version differ");
});

test("unavailable or malformed indexes fall back to paginated API metadata and retry the CDN after its cooldown", async () => {
  for (const unavailable of [new Response("unavailable", { status: 503 }), new Response('{"schema":2}')]) {
    let now = 0;
    let ready = false;
    const urls: string[] = [];

    const catalog = new ReleaseCatalog({
      now: () => now,
      http: new ReleaseHttp({
        now: () => now,
        fetch: async (input) => {
          const url = String(input);
          urls.push(url);

          if (url === RELEASE_INDEX_URL) return ready ? new Response(index) : unavailable;

          return Response.json(
            new URL(url).searchParams.get("page") === "1" ? Array.from({ length: 100 }, () => release) : [],
          );
        },
      }),
    });

    expect((await catalog.releases()).length).toBe(100);
    await catalog.releases();
    expect(urls).toEqual([
      RELEASE_INDEX_URL,
      `${RELEASE_API_URL}/releases?per_page=100&page=1`,
      `${RELEASE_API_URL}/releases?per_page=100&page=2`,
    ]);
    ready = true;
    now = RELEASE_CACHE_MS;
    expect(await catalog.releases()).toEqual([release]);
    expect(urls.at(-1)).toBe(RELEASE_INDEX_URL);
  }
});

test("concurrent readers share a body, revalidate with ETag after 15 minutes, and reuse 304 without losing releases", async () => {
  let now = 0;
  const requests: Headers[] = [];

  const http = new ReleaseHttp({
    now: () => now,
    fetch: async (_url, init) => {
      requests.push(new Headers(init?.headers));
      await Promise.resolve();

      return requests.length === 1
        ? new Response(index, { headers: { etag: '"one"' } })
        : new Response(null, { status: 304 });
    },
  });

  expect(await Promise.all(Array.from({ length: 20 }, () => http.text(RELEASE_INDEX_URL)))).toEqual(
    Array(20).fill(index),
  );
  expect(requests.length).toBe(1);
  now = RELEASE_CACHE_MS - 1;
  expect(await http.text(RELEASE_INDEX_URL)).toBe(index);
  now++;
  expect(await http.text(RELEASE_INDEX_URL)).toBe(index);
  expect(requests[1]?.get("if-none-match")).toBe('"one"');
});

test("403 and 429 pause every repository on the API origin until reset; retries and concurrent peers cannot bypass it", async () => {
  for (const headers of [
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" },
    { "retry-after": "3600" },
    { "retry-after": new Date(3_600_000).toUTCString() },
  ]) {
    let now = 0;
    let calls = 0;

    const http = new ReleaseHttp({
      now: () => now,
      fetch: async () => {
        calls++;

        return now < 3_600_000
          ? new Response(null, { status: headers["retry-after"] ? 429 : 403, headers })
          : new Response(index);
      },
    });

    await expect(http.text(`${RELEASE_API_URL}/releases`)).rejects.toBeInstanceOf(ReleaseRateLimit);

    for (let peer = 0; peer < 10; peer++)
      await expect(http.text(`https://api.github.com/repos/another/repository-${peer}/releases`)).rejects.toMatchObject(
        { retryAt: 3_600_000 },
      );
    expect(calls).toBe(1);
    now = 3_600_000;
    expect(await http.text(`${RELEASE_API_URL}/releases`)).toBe(index);
    expect(calls).toBe(2);
  }
});

test("a plain forbidden response stays an HTTP error; a bodyless 304 and HTTPS downgrade cannot populate the cache", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response(null, { status: 304 }),
    new Response(null, { status: 302, headers: { location: "http://example.com/index" } }),
  ]) {
    const http = new ReleaseHttp({ fetch: async () => response });
    await expect(http.text(RELEASE_INDEX_URL)).rejects.toThrow();
  }
});

test("hour-long scheduled and active traces bound discovery traffic for a desktop, linked computer and browser", async () => {
  for (const active of [false, true])
    for (const available of [false, true]) {
      let now = 0;
      const requests: string[] = [];

      // Desktop, gateway, linked desktop, linked gateway, one browser's BFF.
      const clients = Array.from(
        { length: 5 },
        () =>
          new ReleaseCatalog({
            now: () => now,
            http: new ReleaseHttp({
              now: () => now,
              fetch: async (input, init) => {
                const url = String(input);
                requests.push(url);

                if (url === RELEASE_INDEX_URL && !available) return new Response(null, { status: 503 });

                return new Headers(init?.headers).has("if-none-match")
                  ? new Response(null, { status: 304 })
                  : new Response(url === RELEASE_INDEX_URL ? index : JSON.stringify([release]), {
                      headers: { etag: '"index"' },
                    });
              },
            }),
          }),
      );

      for (let minute = 0; minute < 60; minute++) {
        now = minute * 60_000;

        // Scheduled: hourly desktops, gateways every 15 min, one notes read. Active: each process every minute.
        const due = clients.filter(
          (_client, i) => active || minute === 0 || ((i === 1 || i === 3) && minute % 15 === 0),
        );

        await Promise.all(due.flatMap((client) => [client.releases(), client.releases()]));
      }

      const reads = active ? 20 : 11;
      expect(requests.filter((url) => url === RELEASE_INDEX_URL)).toHaveLength(reads);
      expect(requests.filter((url) => url.startsWith("https://api.github.com"))).toHaveLength(available ? 0 : reads);
    }
});
