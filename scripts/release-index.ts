/** Actions-only, authenticated snapshot. Pages deploys the complete site and index atomically. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { parseReleaseIndex } from "@canopy/domain/release/catalog";
import { releaseChannel } from "@canopy/domain/release/version";
import { pages, repository } from "./release-github.ts";
import { publishedNotes, releaseNotesIndex } from "./release-notes.ts";
import type { JsonValue } from "@canopy/domain/json";
import { limitReleaseBody } from "./release-body.mjs";
import { NIGHTLY_DESKTOP_FEED } from "./version.ts";

const PublishedRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
      state: Schema.String,
    }),
  ),
});

export function releaseIndex(values: readonly JsonValue[], requiredTag?: string): string {
  const releases = Schema.decodeUnknownSync(Schema.Array(PublishedRelease))(values)
    .filter(
      (release) =>
        !release.draft &&
        release.published_at &&
        release.assets.every((asset) => asset.state === "uploaded") &&
        release.assets.some((asset) => asset.name === "manifest.json") &&
        release.assets.some((asset) => asset.name === "checksums.txt"),
    )
    .map((release) => {
      const nightly = release.prerelease && releaseChannel(release.tag_name.replace(/^v/, "")) === "nightly";

      return {
        tag_name: release.tag_name,
        draft: false,
        prerelease: release.prerelease,
        published_at: release.published_at,
        body:
          release.body === null
            ? null
            : limitReleaseBody(
                release.body,
                `https://github.com/itsoltech/canopy/compare/${release.tag_name}^...${release.tag_name}`,
              ),
        // Older desktop clients trust feed aliases when deciding which release belongs in Nightly.
        assets: release.assets.flatMap(({ name, browser_download_url }) =>
          nightly || !NIGHTLY_DESKTOP_FEED.test(name) ? [{ name, browser_download_url }] : [],
        ),
      };
    });

  if (requiredTag && !releases.some((release) => release.tag_name === requiredTag))
    throw new Error(`Published release ${requiredTag} is missing from the index`);
  const text = JSON.stringify({ schema: 1, releases });
  parseReleaseIndex(text);

  return text;
}

if (import.meta.main) {
  // gh authenticates with the workflow's GH_TOKEN. Clients never receive that token.
  const text = releaseIndex(pages(`repos/${repository()}/releases?per_page=100`), process.env["CANOPY_RELEASE_TAG"]);
  const output = process.argv[2] ?? "dist/site/releases/v1.json";
  const previous = await publishedNotes();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${dirname(output)}/notes-v1.json`, releaseNotesIndex(parseReleaseIndex(text), previous));
  await writeFile(output, text);
}
