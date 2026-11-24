import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { botSession } from "./session.ts";

const tempDir = tempDirs();

test("resuming a Codex bot conversation preserves a detached login and manual backup", () => {
  const dataDir = tempDir("canopy-bot-login-");
  const sourceHome = join(dataDir, "device");
  mkdirSync(sourceHome);
  const source = join(sourceHome, "auth.json");
  const replacement = join(sourceHome, "auth.new");
  writeFileSync(source, "old-login");

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    provider: Provider.CODEX,
    configurationKey: "same-settings",
  });

  const options = { dataDir, sourceHome };
  const old = botSession(input, { ...options, linkLogin: false });
  old.save("saved-session");

  const auth = join(old.home, "auth.json");
  linkSync(source, auth);
  // The thread home was repaired manually, but its backup still links to the bot's old file.
  const backup = join(dataDir, "auth.json.manual-backup");
  linkSync(source, backup);
  symlinkSync(join(sourceHome, "auth.lock"), join(old.home, "auth.lock"), "file");
  writeFileSync(replacement, "new-login");
  renameSync(replacement, source);

  const resumed = botSession(input, { ...options, linkLogin: true });

  expect(resumed.id).toBe("saved-session");
  const entries = readdirSync(resumed.home);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.startsWith("auth.json.canopy-backup-")).toBe(true);
  expect(lstatSync(auth, { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(join(resumed.home, entries[0]!), "utf8") === "old-login").toBe(true);
  expect(readFileSync(backup, "utf8")).toBe("old-login");
  expect(readFileSync(source, "utf8")).toBe("new-login");
});

test("Codex bot preparation clears known links even when the selected instance is unlinked", () => {
  const dataDir = tempDir("canopy-bot-login-");
  const sourceHome = join(dataDir, "device");
  mkdirSync(sourceHome);
  const source = join(sourceHome, "auth.json");
  writeFileSync(source, "fixture-login");

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    provider: Provider.CODEX,
  });

  const options = { dataDir, sourceHome, linkLogin: false };
  const prepared = botSession(input, options);
  const auth = join(prepared.home, "auth.json");
  const lock = join(prepared.home, "auth.lock");
  const rollout = join(prepared.home, "rollout.jsonl");
  linkSync(source, auth);
  symlinkSync(join(sourceHome, "auth.lock"), lock, "file");
  writeFileSync(rollout, "fixture-history");
  prepared.save("saved-session");

  const resumed = botSession(input, options);

  expect(resumed.id).toBe("saved-session");
  expect(readdirSync(resumed.home)).toEqual(["rollout.jsonl"]);
  expect(readFileSync(rollout, "utf8")).toBe("fixture-history");
  expect(readFileSync(source, "utf8")).toBe("fixture-login");
});

test("a different profile's login home is protected from bot cleanup", () => {
  const dataDir = tempDir("canopy-bot-login-");

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    provider: Provider.CODEX,
  });

  const options = { dataDir, sourceHome: join(dataDir, "fictional-device"), linkLogin: false };
  const session = botSession(input, options);
  const primary = join(session.home, "auth.json");
  writeFileSync(primary, "fictional");
  expect(() => botSession(input, { ...options, protectedCodexHomes: [session.home] })).toThrow("separate");
  expect(readFileSync(primary, "utf8") === "fictional").toBe(true);
});
