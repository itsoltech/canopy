import { Match } from "effect";
import { compareVersions } from "@canopy/updater/release";
import { ReleaseCatalog, releaseCatalog } from "@canopy/domain/release/catalog";
import type { DesktopReleaseNote } from "@canopy/ui/desktop";

const noteSources = { canopy: "itsoltech/canopy", claude: "anthropics/claude-code", codex: "openai/codex" } as const;

type NoteSource = keyof typeof noteSources;

const catalogs = {
  canopy: releaseCatalog,
  claude: new ReleaseCatalog({ baseUrl: `https://api.github.com/repos/${noteSources.claude}` }),
  codex: new ReleaseCatalog({ baseUrl: `https://api.github.com/repos/${noteSources.codex}` }),
};

const versionOf = (tag: string) => tag.replace(/^rust-v|^v/, "");

export async function updateNotes(
  source: NoteSource,
  current: string,
  target: string,
  channel: string,
): Promise<DesktopReleaseNote[]> {
  compareVersions(current, target);
  const out: DesktopReleaseNote[] = [];

  for (const release of await catalogs[source].releases()) {
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
