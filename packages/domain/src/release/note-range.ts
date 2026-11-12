import { compare, valid } from "semver";
import { entryKey, type NoteEntry, type NotesIndex, type VersionNotes } from "./notes.ts";
import { releaseChannel } from "./version.ts";

export const noteGroups = [
  { type: "feat", title: "New" },
  { type: "perf", title: "Improved" },
  { type: "fix", title: "Fixed" },
] as const;

export interface NoteRange {
  from: string;
  to: string;
  releases: readonly VersionNotes[];
  entries: readonly NoteEntry[];
  incomplete: boolean;
}

export function appVersionIncreased(previous: string, current: string): boolean {
  return Boolean(
    valid(previous) &&
    valid(current) &&
    releaseChannel(previous) !== "development" &&
    releaseChannel(current) !== "development" &&
    compare(current, previous) > 0,
  );
}

/** Newest entry wins; groups order features, performance changes, then fixes. */
export function uniqueEntries(releases: readonly VersionNotes[], seen = new Set<string>()): readonly NoteEntry[] {
  const entries: NoteEntry[] = [];

  for (const release of releases) {
    for (const entry of release.entries) {
      const key = entryKey(entry);

      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }

  return noteGroups.flatMap((group) => entries.filter((entry) => entry.type === group.type));
}

/** Promotions repeat earlier PRs in cumulative release bodies: remove changes already delivered. */
export function aggregateNotes(index: NotesIndex, from: string, to: string): NoteRange {
  const result: NoteRange = { from, to, releases: [], entries: [], incomplete: false };

  if (!appVersionIncreased(from, to)) return result;
  const channel = releaseChannel(to);
  const previousChannel = releaseChannel(from);
  const ordered = index.releases.toSorted((a, b) => compare(b.version, a.version));

  const releases = ordered.filter(
    (release) =>
      releaseChannel(release.version) === channel &&
      compare(release.version, from) > 0 &&
      compare(release.version, to) <= 0,
  );

  const seen = new Set<string>();

  for (const release of ordered) {
    if (releaseChannel(release.version) !== previousChannel || compare(release.version, from) > 0) continue;

    for (const entry of release.entries) seen.add(entryKey(entry));
  }

  const oldest = releases.at(-1);
  const truncated = index.truncated.includes(channel === "development" ? "stable" : channel);
  const previousMissing = !index.releases.some((release) => release.version === from);

  return {
    from,
    to,
    releases,
    entries: uniqueEntries(releases, seen),
    incomplete:
      !index.releases.some((release) => release.version === to) ||
      ((truncated || channel === previousChannel) && (!oldest || compare(from, oldest.version) < 0) && previousMissing),
  };
}
