import { expect, test } from "bun:test";
import { aggregateNotes, appVersionIncreased } from "./note-range.ts";
import { fetchReleaseNotes, parseNotesIndex, recentNotes, type NoteEntry, type NotesIndex } from "./notes.ts";
import { ReleaseHttp } from "./http.ts";
import { AppUpdateHistory } from "./app-history.ts";

const entry = (pr: number, type: NoteEntry["type"] = "feat"): NoteEntry => ({
  type,
  pr,
  url: `https://github.com/itsoltech/canopy/pull/${pr}`,
  scope: "updates",
  summary: `Change ${pr}`,
});

const release = (version: string, entries: readonly NoteEntry[]) => ({ version, date: "2026-11-13", entries });
const index = (releases: NotesIndex["releases"]): NotesIndex => ({ schema: 1, releases, truncated: [] });

test("device-local history survives restart and dismissal, keeps the actual range, and resets on downgrade", () => {
  let saved = "";
  const history = new AppUpdateHistory((raw) => (saved = raw));
  history.load(null);
  expect(history.observe("0.2.0-nightly.133")).toBe(false);
  expect(history.observe("0.2.0-nightly.146")).toBe(true);
  expect(history.range).toEqual({ from: "0.2.0-nightly.133", to: "0.2.0-nightly.146" });
  const restarted = new AppUpdateHistory((raw) => (saved = raw));
  restarted.load(saved);
  expect(restarted.observe("0.2.0-nightly.146")).toBe(false);
  expect(restarted.range).toEqual(history.range);
  expect(restarted.observe("0.2.0-nightly.100")).toBe(false);
  expect(restarted.range).toBeUndefined();
  expect(restarted.observe("0.2.0-nightly.101")).toBe(true);
  const otherDevice = new AppUpdateHistory(() => {});
  otherDevice.load(null);
  expect(otherDevice.observe("0.2.0-nightly.146")).toBe(false);
  expect(otherDevice.range).toBeUndefined();
});

test("many skipped nightlies aggregate the exclusive/inclusive range, deduped and ordered by relevance then recency", () => {
  const types = ["fix", "perf", "feat"] as const;

  const notes = index(
    Array.from({ length: 146 }, (_, i) => release(`0.2.0-nightly.${i + 1}`, [entry(i + 1, types[i % 3])])),
  );

  const current = notes.releases.find((r) => r.version === "0.2.0-nightly.146")!;

  const range = aggregateNotes(
    index([...notes.releases, release("0.2.0-nightly.147", [entry(147)])]),
    "0.2.0-nightly.133",
    "0.2.0-nightly.146",
  );

  expect(range.releases).toHaveLength(13);
  expect(range.entries).toHaveLength(13);
  expect(range.entries[0]?.pr).toBe(144);
  expect(range.entries.at(-1)?.pr).toBe(136);
  expect(range.entries.map((item) => item.pr)).not.toContain(133);
  expect(range.entries.map((item) => item.pr)).not.toContain(147);
  expect(range.incomplete).toBe(false);
  expect(
    aggregateNotes(
      index([...notes.releases.filter((r) => r !== current), release(current.version, [entry(145), entry(146)])]),
      "0.2.0-nightly.133",
      current.version,
    ).entries,
  ).toHaveLength(13);
});

test("promotion bodies exclude previously delivered PRs across nightly, beta and stable channels", () => {
  const notes = index([
    release("0.2.0-nightly.1", [entry(1)]),
    release("0.2.0-nightly.2", [entry(2)]),
    release("0.2.0-beta.1", [entry(1), entry(2)]),
    release("0.2.0-beta.2", [entry(3, "fix")]),
    release("0.2.0-nightly.3", [entry(4)]),
    release("0.2.0", [entry(1), entry(2), entry(3, "fix"), entry(5)]),
    release("0.3.0-nightly.1", [entry(6)]),
  ]);

  expect(aggregateNotes(notes, "0.2.0-nightly.2", "0.2.0").entries.map((e) => e.pr)).toEqual([5, 3]);
  expect(aggregateNotes(notes, "0.2.0-beta.1", "0.2.0").entries.map((e) => e.pr)).toEqual([5, 3]);
  expect(aggregateNotes(notes, "0.1.0", "0.2.0-beta.2").entries.map((e) => e.pr)).toEqual([1, 2, 3]);
  expect(aggregateNotes(notes, "0.2.0-beta.1", "0.2.0-nightly.3").entries.map((e) => e.pr)).toEqual([4]);
  expect(recentNotes(notes, "0.2.0-beta.2").map((r) => r.version)).toEqual(["0.2.0-beta.2", "0.2.0-beta.1"]);
});

test("unknown versions, first installs, repeated launches and downgrades do not open full history", () => {
  for (const from of ["", "garbage", "0.0.0-dev", "0.2.0", "0.3.0-nightly.1"]) {
    expect(appVersionIncreased(from, "0.2.0")).toBe(false);
    expect(aggregateNotes(index([release("0.2.0", [entry(1)])]), from, "0.2.0").entries).toEqual([]);
  }

  expect(appVersionIncreased("0.2.0", "0.0.0-dev")).toBe(false);
});

test("bounded history and publication lag are explicit rather than claiming complete release notes", () => {
  const notes: NotesIndex = { ...index([release("0.2.0-nightly.100", [entry(1)])]), truncated: ["nightly"] };
  expect(aggregateNotes(notes, "0.2.0-nightly.1", "0.2.0-nightly.100").incomplete).toBe(true);
  expect(aggregateNotes(notes, "0.2.0-nightly.100", "0.2.0-nightly.101").incomplete).toBe(true);
});

test("notes reject invalid schemas, versions, dates, duplicate versions and untrusted PR URLs", () => {
  const good = index([release("0.2.0", [entry(1)])]);
  expect(parseNotesIndex(JSON.stringify(good))).toEqual(good);

  for (const bad of [
    { ...good, schema: 2 },
    index([release("broken", [entry(1)])]),
    index([{ ...release("0.2.0", []), date: "bad" }]),
    index([release("0.2.0", []), release("0.2.0", [])]),
    index([release("0.2.0", [{ ...entry(1), url: "javascript:alert(1)" }])]),
    index([release("0.2.0", [{ ...entry(1), pr: 1.5 }])]),
  ])
    expect(() => parseNotesIndex(JSON.stringify(bad))).toThrow();
});

test("a failed Pages fetch makes no GitHub API request", async () => {
  const urls: string[] = [];

  const http = new ReleaseHttp({
    fetch: async (url) => {
      urls.push(String(url));

      return new Response("Unavailable", { status: 503 });
    },
  });

  await expect(fetchReleaseNotes(http)).rejects.toThrow();
  expect(urls).toEqual(["https://itsoltech.github.io/canopy/releases/notes-v1.json"]);
});
