import { expect, test } from "bun:test";
import { releaseIndex } from "./release-index.ts";
import { parseReleaseIndex } from "@canopy/domain/release/catalog";

const release = {
  tag_name: "v1.2.3",
  draft: false,
  prerelease: false,
  published_at: "2026-11-10T09:00:00Z",
  body: "Notes",
  assets: ["manifest.json", "checksums.txt", "latest-linux.yml", "Canopy-1.2.3-linux-x64.AppImage"].map((name) => ({
    name,
    browser_download_url: `https://github.com/itsoltech/canopy/releases/download/v1.2.3/${name}`,
    state: "uploaded",
  })),
};

test("the Pages snapshot includes notes and all download URLs only for complete public releases", () => {
  const text = releaseIndex(
    [
      release,
      { ...release, tag_name: "v1.3.0", draft: true, published_at: null },
      { ...release, tag_name: "v1.4.0", assets: release.assets.filter((asset) => asset.name !== "manifest.json") },
      { ...release, tag_name: "v1.5.0", assets: release.assets.filter((asset) => asset.name !== "checksums.txt") },
      {
        ...release,
        tag_name: "v1.6.0",
        assets: [
          ...release.assets,
          { name: "new.zip", browser_download_url: "https://example.com/new.zip", state: "new" },
        ],
      },
    ],
    "v1.2.3",
  );

  const parsed = parseReleaseIndex(text);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ tag_name: "v1.2.3", body: "Notes", published_at: release.published_at });
  expect(parsed[0]?.assets).toEqual(
    release.assets.map(({ name, browser_download_url }) => ({ name, browser_download_url })),
  );
});

test("missing just-published releases, duplicate tags and malformed data fail before replacing the live Pages snapshot", () => {
  expect(() => releaseIndex([release], "v2.0.0")).toThrow("missing from the index");
  expect(() => releaseIndex([{ ...release, draft: true }], "v1.2.3")).toThrow("missing from the index");
  expect(() => releaseIndex([release, release])).toThrow("Invalid release index");
  expect(() => releaseIndex([{ tag_name: "v1.2.3" }])).toThrow();
});
