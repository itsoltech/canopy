import { expect, test } from "bun:test";
import { DesktopUpdateFeed } from "../src/update-feed.ts";
import { ReleaseCatalog, RELEASE_INDEX_URL } from "@canopy/domain/release/catalog";
import { ReleaseHttp } from "@canopy/domain/release/http";

const release = (tag: string, prerelease: boolean) => ({
  tag_name: tag,
  draft: false,
  prerelease,
  published_at: "2026-11-10T09:00:00Z",
  body: `${tag} notes`,
  assets: [
    "manifest.json",
    "latest.yml",
    "latest-mac.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
    "beta.yml",
    "beta-mac.yml",
    "beta-linux.yml",
    "beta-linux-arm64.yml",
    "nightly.yml",
    "nightly-mac.yml",
    "nightly-linux.yml",
    "nightly-linux-arm64.yml",
  ].map((name) => ({
    name,
    browser_download_url: `https://github.com/itsoltech/canopy/releases/download/${tag}/${name}`,
  })),
});

test("desktop shares the static catalog and compares each candidate once across peers", async () => {
  const urls: string[] = [];
  const releases = [release("v1.2.3", false), release("v1.3.0-nightly.1", true)];

  const catalog = new ReleaseCatalog({
    http: new ReleaseHttp({
      fetch: async (input) => {
        urls.push(String(input));

        if (String(input).includes("/compare/")) return Response.json({ status: "ahead" });

        return Response.json({ schema: 1, releases });
      },
    }),
  });

  const feed = new DesktopUpdateFeed(() => "1.2.0", catalog);
  const signal = new AbortController().signal;

  const [stable, nightly, peer] = await Promise.all([
    feed.resolve("stable", signal),
    feed.resolve("nightly", signal),
    feed.resolve("stable", signal),
  ]);

  expect(stable.release?.tag_name).toBe("v1.2.3");
  expect(stable.releases).toEqual([{ version: "1.2.3", markdown: "v1.2.3 notes" }]);
  expect(nightly.release?.tag_name).toBe("v1.3.0-nightly.1");
  expect(peer).toEqual(stable);
  expect(urls).toEqual([
    RELEASE_INDEX_URL,
    "https://api.github.com/repos/itsoltech/canopy/compare/v1.2.0...v1.2.3?per_page=1",
    "https://api.github.com/repos/itsoltech/canopy/compare/v1.2.0...v1.3.0-nightly.1?per_page=1",
  ]);
});

test("an old nightly feed alias cannot offer stable or beta to nightly installations", async () => {
  const releases = [release("v0.5.0", false), release("v0.6.0-beta.1", true), release("v0.5.0-nightly.4", true)];

  const catalog = new ReleaseCatalog({
    http: new ReleaseHttp({
      fetch: async (input) =>
        String(input).includes("/compare/")
          ? Response.json({ status: "ahead" })
          : Response.json({ schema: 1, releases }),
    }),
  });

  const feed = new DesktopUpdateFeed(() => "0.5.0-nightly.4", catalog);
  const signal = new AbortController().signal;

  expect(await feed.resolve("nightly", signal)).toMatchObject({
    release: undefined,
    publishing: undefined,
    releases: [],
  });
  releases.push(release("v0.5.0-nightly.5", true));
  const next = await feed.resolve("nightly", signal, true);
  expect(next.release?.tag_name).toBe("v0.5.0-nightly.5");
  expect(next.releases.map(({ version }) => version)).toEqual(["0.5.0-nightly.5"]);
});

test("a higher-numbered release waits when its code is older, diverged or unavailable", async () => {
  const stable = release("v0.5.0", false);
  const revision = "a".repeat(40);

  for (const comparison of ["behind", "diverged", "missing", "identical", "ahead"]) {
    const catalog = new ReleaseCatalog({
      http: new ReleaseHttp({
        fetch: async (input) => {
          if (String(input) === RELEASE_INDEX_URL) return Response.json({ schema: 1, releases: [stable] });
          expect(String(input)).toContain(`/compare/${revision}...v0.5.0`);

          return comparison === "missing" ? new Response(null, { status: 404 }) : Response.json({ status: comparison });
        },
      }),
    });

    const feed = new DesktopUpdateFeed(() => "0.5.0-nightly.4", catalog, revision);
    const result = await feed.resolve("stable", new AbortController().signal);
    expect(result.release?.tag_name).toBe(comparison === "identical" || comparison === "ahead" ? "v0.5.0" : undefined);
  }
});
