import { compare, valid } from "semver";
import { markdownText } from "@canopy/domain/markdown";
import { type CatalogRelease } from "@canopy/domain/release/catalog";
import { releaseChannel } from "@canopy/domain/release/version";
import {
  NOTES_PER_CHANNEL,
  entryKey,
  noteChannels,
  parseNotesIndex,
  type NoteEntry,
  type VersionNotes,
} from "@canopy/domain/release/notes";

const sections = new Map<string, NoteEntry["type"]>([
  ["features", "feat"],
  ["bug fixes", "fix"],
  ["performance improvements", "perf"],
]);

function parseEntry(raw: string, type: NoteEntry["type"]): NoteEntry | undefined {
  const scopeMatch = /^\*\*([^*]+?):\*\*\s*/.exec(raw);
  const prefix = /^(feat|fix|perf)(?:\(([^)]+)\))?!?:\s*/.exec(raw);
  const scope = scopeMatch?.[1] ?? prefix?.[2] ?? "";
  const prMatch = /\[#(\d+)\]\(https:\/\/github\.com\/itsoltech\/canopy\/(?:pull|issues)\/\1\)|\(#(\d+)\)/.exec(raw);
  const pr = prMatch ? Number(prMatch[1] ?? prMatch[2]) : null;

  const summary = markdownText(
    raw
      .slice(scopeMatch?.[0].length ?? prefix?.[0].length ?? 0)
      .replace(/\[#[0-9]+\]\(https:\/\/github\.com\/itsoltech\/canopy\/(?:pull|issues)\/[0-9]+\)/g, "")
      .replace(/\[[a-f0-9]{7,40}\]\(https:\/\/github\.com\/itsoltech\/canopy\/commit\/[a-f0-9]+\)/g, "")
      .replace(/\(#[0-9]+\)/g, "")
      .replace(/\(\s*\)/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();

  if (!summary) return undefined;

  return {
    type,
    scope,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    pr,
    url: pr === null ? null : `https://github.com/itsoltech/canopy/pull/${pr}`,
  };
}

/** Angular semantic-release bodies only; prose, credits and unrecognized sections stay out of the UI. */
export function parseReleaseBody(body: string): readonly NoteEntry[] {
  const entries: NoteEntry[] = [];
  const seen = new Set<string>();
  let type: NoteEntry["type"] | undefined;
  let item = "";

  const flush = () => {
    const entry = type && item ? parseEntry(item, type) : undefined;
    item = "";

    if (entry && !seen.has(entryKey(entry))) {
      seen.add(entryKey(entry));
      entries.push(entry);
    }
  };

  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);

    if (heading) {
      flush();
      type = sections.get(heading[1]!.toLowerCase());
    } else if (bullet) {
      flush();
      item = bullet[1]!;
    } else if (item && /^\s+\S/.test(line)) item += ` ${line.trim()}`;
    else if (!line.trim()) flush();
  }

  flush();

  return entries;
}

export function releaseNotesIndex(releases: readonly CatalogRelease[]): string {
  const notes: VersionNotes[] = releases.flatMap((release) => {
    const version = release.tag_name.replace(/^v/, "");

    return !release.draft && valid(version) && releaseChannel(version) !== "development"
      ? [{ version, date: release.published_at, entries: parseReleaseBody(release.body ?? "") }]
      : [];
  });

  notes.sort((a, b) => compare(b.version, a.version));

  const channels = noteChannels.map((channel) => ({
    channel,
    releases: notes.filter((release) => releaseChannel(release.version) === channel),
  }));

  const text = JSON.stringify({
    schema: 1,
    releases: channels.flatMap(({ releases }) => releases.slice(0, NOTES_PER_CHANNEL)),
    truncated: channels.filter(({ releases }) => releases.length > NOTES_PER_CHANNEL).map(({ channel }) => channel),
  });

  parseNotesIndex(text);

  return text;
}
