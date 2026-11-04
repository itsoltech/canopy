import { Schema, Match } from "effect";
import { compareVersions } from "@canopy/updater/release";
import type { DesktopReleaseNote } from "@canopy/ui/desktop";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  body: Schema.NullOr(Schema.String),
});

type Release = Schema.Schema.Type<typeof Release>;

const noteSources = { canopy: "itsoltech/canopy", claude: "anthropics/claude-code", codex: "openai/codex" } as const;

type NoteSource = keyof typeof noteSources;

const cache = new Map<NoteSource, { at: number; value: Promise<readonly Release[]> }>();
const versionOf = (tag: string) => tag.replace(/^rust-v|^v/, "");

async function releases(source: NoteSource): Promise<readonly Release[]> {
  const cached = cache.get(source);

  if (cached && Date.now() - cached.at < 60_000) return cached.value;

  const value = (async () => {
    const all: Release[] = [];

    for (let page = 1; page <= 10; page++) {
      const response = await fetch(
        `https://api.github.com/repos/${noteSources[source]}/releases?per_page=100&page=${page}`,
        {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "Canopy-Updates" },
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) throw new Error(`Release notes unavailable (GitHub HTTP ${response.status}). Retry later.`);
      const batch = Schema.decodeUnknownSync(Schema.Array(Release))(await response.json());
      all.push(...batch);

      if (batch.length < 100) return all;
    }

    throw new Error("Release history could not be loaded completely");
  })();

  cache.set(source, { at: Date.now(), value });

  return value;
}

export async function updateNotes(
  source: NoteSource,
  current: string,
  target: string,
  channel: string,
): Promise<DesktopReleaseNote[]> {
  compareVersions(current, target);
  const out: DesktopReleaseNote[] = [];

  for (const release of await releases(source)) {
    if (release.draft) continue;
    const version = versionOf(release.tag_name);

    try {
      if (compareVersions(version, current) <= 0 || compareVersions(version, target) > 0) continue;
    } catch {
      continue;
    }

    const prerelease = version.split("-")[1]?.split(".")[0];

    if (source === "canopy") {
      const allowed: readonly string[] = Match.value(channel).pipe(
        Match.when("nightly", () => ["beta", "nightly"]),
        Match.when("beta", () => ["beta"]),
        Match.orElse(() => []),
      );

      if (prerelease ? !release.prerelease || !allowed.includes(prerelease) : release.prerelease) continue;
    } else if (release.prerelease) continue;

    if (release.body?.trim()) out.push({ version, markdown: release.body });
  }

  return out.sort((a, b) => compareVersions(b.version, a.version));
}
