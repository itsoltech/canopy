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
    "nightly.yml",
    "nightly-mac.yml",
    "nightly-linux.yml",
    "nightly-linux-arm64.yml",
  ].map((name) => ({
    name,
    browser_download_url: `https://github.com/itsoltech/canopy/releases/download/${tag}/${name}`,
  })),
});

test("desktop reads the static catalog for channel selection and notes without any API request from peers", async () => {
  const urls: string[] = [];
  const releases = [release("v1.2.3", false), release("v1.3.0-nightly.1", true)];

  const catalog = new ReleaseCatalog({
    http: new ReleaseHttp({
      fetch: async (input) => {
        urls.push(String(input));

        return Response.json({ schema: 1, releases });
      },
    }),
  });

  const feed = new DesktopUpdateFeed(() => "1.2.0", catalog);
  const signal = new AbortController().signal;

  const [stable, nightly, peer] = await Promise.all([
    feed.resolve("stable", false, signal),
    feed.resolve("nightly", false, signal),
    feed.resolve("stable", false, signal),
  ]);

  expect(stable.release?.tag_name).toBe("v1.2.3");
  expect(stable.releases).toEqual([{ version: "1.2.3", markdown: "v1.2.3 notes" }]);
  expect(nightly.release?.tag_name).toBe("v1.3.0-nightly.1");
  expect(peer).toEqual(stable);
  expect(urls).toEqual([RELEASE_INDEX_URL]);
});
