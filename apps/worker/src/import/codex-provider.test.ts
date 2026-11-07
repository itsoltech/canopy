import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { prepareImportedCodexResume } from "./codex-provider.ts";
import { PrivateCopy, removeCopy } from "./copy.ts";
import { treeFingerprint } from "./fixtures/install.ts";

const temp = tempDirs();
const sessionId = "00000000-0000-4000-8000-000000000001";
const rel = `sessions/2026/11/06/rollout-2026-11-06T22-03-21-${sessionId}.jsonl`;
const history = `${JSON.stringify({ type: "response_item", payload: { type: "message", text: "Remember history", id: "turn-ref" } })}\n`;
const rollout = `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, model_provider: "cliproxyapi" } })}\n${history}`;

function fixture() {
  const root = temp("canopy-import-provider-");
  const home = join(root, "private");
  const manifest = join(root, "copies", "codex.json");
  const copy = new PrivateCopy(home, manifest);
  copy.write(rel, [rollout]);
  copy.commit({ size: String(rollout.length), prefixSha256: "source-snapshot" });

  return { root, home, manifest, path: join(home, rel) };
}

test("import repair updates only the matching private index row, preserves history and remains removable", () => {
  const f = fixture();
  const db = new Database(join(f.home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, model_provider TEXT)");
  const insert = db.query("INSERT INTO threads VALUES (?, ?, ?)");
  insert.run(sessionId, f.path, "cliproxyapi");
  insert.run("another-session", f.path, "other-provider");
  insert.run(sessionId, "different-rollout", "other-provider");

  try {
    expect(prepareImportedCodexResume(f.manifest, f.home, sessionId, "canopy_native")).toBe(f.path);
    expect(readFileSync(f.path, "utf8")).toBe(rollout.replace("cliproxyapi", "canopy_native"));
    expect(db.query("SELECT model_provider FROM threads").all()).toEqual([
      { model_provider: "canopy_native" },
      { model_provider: "other-provider" },
      { model_provider: "other-provider" },
    ]);
    const before = treeFingerprint(f.home);
    prepareImportedCodexResume(f.manifest, f.home, sessionId, "canopy_native");
    expect(treeFingerprint(f.home)).toBe(before);
    removeCopy(f.manifest, f.home);
    expect(() => readFileSync(f.path)).toThrow();
  } finally {
    db.close();
  }
});

test("repair leaves unowned files and a linked CLI home untouched", () => {
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "original.jsonl"), rollout);
  const linked = join(f.root, "linked");
  symlinkSync(source, linked);
  const before = treeFingerprint(source);
  expect(prepareImportedCodexResume(f.manifest, linked, sessionId, "openai")).toBeUndefined();
  expect(prepareImportedCodexResume(join(f.root, "absent"), f.home, sessionId, "openai")).toBeUndefined();
  expect(treeFingerprint(source)).toBe(before);
  expect(readFileSync(f.path, "utf8")).toBe(rollout);
});

test.each(["", "-wal", "-shm", "-journal"])("repair refuses a linked private index%s", (suffix) => {
  const f = fixture();
  const source = join(f.root, "source.sqlite");
  writeFileSync(source, "source stays unchanged");
  const index = join(f.home, "state_5.sqlite");

  if (suffix) writeFileSync(index, "");
  symlinkSync(source, index + suffix);
  expect(() => prepareImportedCodexResume(f.manifest, f.home, sessionId, "openai")).toThrow("link or special file");
  expect(readFileSync(source, "utf8")).toBe("source stays unchanged");
});

test("repair refuses a private index hard-linked to another file", () => {
  const f = fixture();
  const source = join(f.root, "source.sqlite");
  writeFileSync(source, "source stays unchanged");
  linkSync(source, join(f.home, "state_5.sqlite"));
  expect(() => prepareImportedCodexResume(f.manifest, f.home, sessionId, "openai")).toThrow("link or special file");
  expect(readFileSync(source, "utf8")).toBe("source stays unchanged");
});
