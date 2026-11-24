import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { prepareBotCodexSqliteHome } from "./codex-sqlite-home.ts";
import { botSessionInstanceKey } from "./session.ts";

const temp = tempDirs();

function fixture() {
  const root = temp("canopy-bot-sqlite-");
  // Match the failure where the rollback journal crosses MAX_PATH while the legacy database still fits.
  const home = join(root, "legacy".padEnd(Math.max(6, 229 - root.length), "x"));
  mkdirSync(home);
  const historyJournal = join(home, "thread_history_1.sqlite-journal");
  expect(historyJournal.length).toBeGreaterThanOrEqual(260);

  const identity = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    botSessionInstanceKey(Provider.CODEX, "fixture"),
  ] as const;

  return { root, home, identity };
}

test("compacting a Windows Codex database preserves committed WAL rows and keeps the first snapshot", () => {
  const { root, home, identity } = fixture();
  const legacyPath = join(home, "state_5.sqlite");
  const sentinel = "FIXTURE_COMMITTED_WAL_ROW";
  const credential = "FIXTURE_PROFILE_CREDENTIAL";
  writeFileSync(join(home, "auth.json"), credential);
  writeFileSync(join(home, "extra.sqlite"), credential);

  using legacy = new Database(legacyPath);
  legacy.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE threads (id TEXT PRIMARY KEY)");
  legacy.query("INSERT INTO threads VALUES (?)").run(sentinel);
  expect(readFileSync(legacyPath).includes(sentinel)).toBe(false);
  expect(readFileSync(`${legacyPath}-wal`).includes(sentinel)).toBe(true);

  const compact = prepareBotCodexSqliteHome(root, home, identity);
  expect(compact === home).toBe(false);
  expect(join(compact, "thread_history_1.sqlite-journal").length).toBeLessThan(260);
  expect(existsSync(legacyPath)).toBe(true);
  expect(existsSync(join(compact, "auth.json"))).toBe(false);
  expect(existsSync(join(compact, "extra.sqlite"))).toBe(false);

  const snapshotPath = join(compact, "state_5.sqlite");
  expect(readFileSync(snapshotPath).includes(credential)).toBe(false);
  using snapshot = new Database(snapshotPath, { readonly: true });
  expect(snapshot.query("SELECT id FROM threads").values()).toEqual([[sentinel]]);

  legacy.query("INSERT INTO threads VALUES ('second legacy row')").run();
  expect(prepareBotCodexSqliteHome(root, home, identity) === compact).toBe(true);
  using reopened = new Database(snapshotPath, { readonly: true });
  expect(reopened.query("SELECT id FROM threads").values()).toEqual([[sentinel]]);
  expect(legacy.query("SELECT id FROM threads ORDER BY id").values()).toEqual([[sentinel], ["second legacy row"]]);
});

test("explicit Codex SQLite configuration leaves both database locations alone", () => {
  const { root, home, identity } = fixture();
  const external = temp("canopy-bot-explicit-sqlite-");
  const state = "FIXTURE_EXTERNAL_SQLITE_STATE";
  const externalFile = join(external, "state_5.sqlite");
  writeFileSync(externalFile, state);
  // Attempting to open this file would fail. Explicit configuration skips the default migration entirely.
  writeFileSync(join(home, "state_5.sqlite"), "FIXTURE_UNAVAILABLE_DEFAULT_DATABASE");

  for (const env of [{ CODEX_SQLITE_HOME: external }, { codex_sqlite_home: external }]) {
    expect(prepareBotCodexSqliteHome(root, home, identity, [], env)).toBe(home);
  }

  writeFileSync(join(home, "config.toml"), `"sqlite_home" = ${JSON.stringify(external)}`);
  expect(prepareBotCodexSqliteHome(root, home, identity)).toBe(home);
  expect(existsSync(join(root, "bdb"))).toBe(false);
  expect(readFileSync(externalFile, "utf8")).toBe(state);
});

test("compact storage checks protected path overlap without requiring an unrelated profile directory", () => {
  const { root, home, identity } = fixture();
  const unrelated = join(root, "unrelated-provider-home");
  writeFileSync(unrelated, "FIXTURE_UNAVAILABLE_PROFILE");

  const compact = prepareBotCodexSqliteHome(root, home, identity, [unrelated]);
  const alias = join(root, "provider-home-alias");
  symlinkSync(compact, alias, "junction");

  expect(compact).not.toBe(home);
  expect(() => prepareBotCodexSqliteHome(root, home, identity, [alias])).toThrow("separate");
});
