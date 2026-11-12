import { Schema } from "effect";
import { valid, compare } from "semver";
import { releaseChannel } from "./version.ts";
import { releaseHttp, type ReleaseHttp } from "./http.ts";

export const RELEASE_NOTES_URL = "https://itsoltech.github.io/canopy/releases/notes-v1.json";
export const NOTES_PER_CHANNEL = 200;
export const noteChannels = ["stable", "beta", "nightly"] as const;

export type NoteChannel = (typeof noteChannels)[number];

const Entry = Schema.Struct({
  type: Schema.Literals(["feat", "perf", "fix"]),
  scope: Schema.String,
  summary: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
});

const Release = Schema.Struct({ version: Schema.String, date: Schema.String, entries: Schema.Array(Entry) });

const Index = Schema.Struct({
  schema: Schema.Literal(1),
  releases: Schema.Array(Release),
  truncated: Schema.Array(Schema.Literals(noteChannels)),
});

export type NoteEntry = Schema.Schema.Type<typeof Entry>;

export type VersionNotes = Schema.Schema.Type<typeof Release>;

export type NotesIndex = Schema.Schema.Type<typeof Index>;

export function entryKey(entry: NoteEntry): string {
  return entry.pr ? `pr:${entry.pr}` : `${entry.scope}:${entry.summary}`.toLowerCase();
}

/** Strict boundary: plain text only, and links can only point to this repository's PRs. */
export function parseNotesIndex(text: string): NotesIndex {
  if (text.length > 8 * 1024 * 1024) throw new Error("Release notes are too large");
  const index = Schema.decodeUnknownSync(Index)(JSON.parse(text));
  const versions = new Set<string>();
  const counts = { stable: 0, beta: 0, nightly: 0 };

  for (const release of index.releases) {
    const channel = releaseChannel(release.version);

    if (
      !valid(release.version) ||
      channel === "development" ||
      versions.has(release.version) ||
      !Number.isFinite(Date.parse(release.date)) ||
      ++counts[channel] > NOTES_PER_CHANNEL
    )
      throw new Error("Invalid release notes version");
    versions.add(release.version);

    for (const entry of release.entries) {
      if (
        !entry.summary.trim() ||
        entry.summary.length > 2000 ||
        entry.scope.length > 100 ||
        (entry.pr === null
          ? entry.url !== null
          : !Number.isSafeInteger(entry.pr) ||
            entry.pr < 1 ||
            entry.url !== `https://github.com/itsoltech/canopy/pull/${entry.pr}`)
      )
        throw new Error("Invalid release notes entry");
    }
  }

  return index;
}

/** Pages only. A failed CDN read never falls back to GitHub's API. */
export async function fetchReleaseNotes(http: ReleaseHttp = releaseHttp): Promise<NotesIndex> {
  return parseNotesIndex(await http.text(RELEASE_NOTES_URL));
}

/** Recent releases of the running build's channel; never preview a newer installed app. */
export function recentNotes(index: NotesIndex, current: string): readonly VersionNotes[] {
  if (!valid(current)) return [];
  const channel = releaseChannel(current);

  return index.releases
    .filter((release) => releaseChannel(release.version) === channel && compare(release.version, current) <= 0)
    .toSorted((a, b) => compare(b.version, a.version))
    .slice(0, 10);
}
