import { expect, test } from "bun:test";
import fixtures from "./fixtures/release-notes.json";
import { parseReleaseBody, publishedNotes, releaseNotesIndex } from "./release-notes.ts";
import { releaseIndex } from "./release-index.ts";
import { parseReleaseIndex } from "@canopy/domain/release/catalog";
import { parseNotesIndex, NOTES_PER_CHANNEL } from "@canopy/domain/release/notes";
import { ReleaseHttp } from "@canopy/domain/release/http";

test("Angular release bodies become plain summaries, scopes, PRs and groups without commit metadata", () => {
  for (const fixture of fixtures)
    expect(parseReleaseBody(fixture.body)).toEqual<typeof fixture.entries>(fixture.entries);
  expect(parseReleaseBody("No releasable changes.")).toEqual([]);
});

test("Pages notes retain the latest 200 versions of each channel, with stable notes independent of nightly volume", () => {
  const versions = [
    "0.1.0",
    "0.2.0",
    "0.2.0-beta.1",
    ...Array.from({ length: 230 }, (_, i) => `0.2.0-nightly.${i + 1}`),
  ];

  const values = versions.map((version) => ({
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    published_at: "2026-11-13T12:00:00Z",
    body: fixtures[0]!.body,
    assets: ["manifest.json", "checksums.txt"].map((name) => ({
      name,
      browser_download_url: `https://github.com/itsoltech/canopy/releases/download/v${version}/${name}`,
      state: "uploaded",
    })),
  }));

  const index = parseNotesIndex(releaseNotesIndex(parseReleaseIndex(releaseIndex(values))));
  expect(index.truncated).toEqual(["nightly"]);
  expect(index.releases).toHaveLength(NOTES_PER_CHANNEL + 3);
  const expected = fixtures[0]!.entries;
  expect(index.releases.find((r) => r.version === "0.2.0")?.entries).toEqual<typeof expected>(expected);
  expect(index.releases.some((r) => r.version === "0.2.0-nightly.30")).toBe(false);
  expect(index.releases.some((r) => r.version === "0.2.0-nightly.31")).toBe(true);
  expect(index.releases.find((r) => r.version.includes("nightly"))?.version).toBe("0.2.0-nightly.230");
  expect(parseNotesIndex(releaseNotesIndex([], index))).toEqual(index);
});

test("Pages preserves pruned nightly notes and replaces edited bodies without duplicating versions", () => {
  const published = {
    tag_name: "v0.2.0-nightly.133",
    draft: false,
    prerelease: true,
    published_at: "2026-11-13T12:00:00Z",
    body: fixtures[0]!.body,
    assets: [],
  };

  const previous = parseNotesIndex(releaseNotesIndex([published]));
  const current = { ...published, tag_name: "v0.2.0-nightly.146" };
  const retained = parseNotesIndex(releaseNotesIndex([current], previous));
  expect(retained.releases.map((r) => r.version)).toEqual(["0.2.0-nightly.146", "0.2.0-nightly.133"]);
  const edited = parseNotesIndex(releaseNotesIndex([{ ...current, body: fixtures[1]!.body }], retained));
  expect(edited.releases).toHaveLength(2);
  expect(edited.releases[0]?.entries).toEqual<ReturnType<typeof parseReleaseBody>>(parseReleaseBody(fixtures[1]!.body));
  expect(edited.releases[1]).toEqual(previous.releases[0]);
});

test("only a missing initial Pages archive permits bootstrap; outages and invalid JSON preserve the last deployment", async () => {
  const http = (status: number, body: string) => new ReleaseHttp({ fetch: async () => new Response(body, { status }) });
  expect(await publishedNotes(http(404, "Not found"))).toBeUndefined();
  await expect(publishedNotes(http(503, "Unavailable"))).rejects.toThrow();
  await expect(publishedNotes(http(200, "broken"))).rejects.toThrow();
  const empty = { schema: 1, releases: [], truncated: [] };
  expect(await publishedNotes(http(200, JSON.stringify(empty)))).toEqual(empty);
});
