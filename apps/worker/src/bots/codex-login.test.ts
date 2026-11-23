import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { botSession } from "./session.ts";

const tempDir = tempDirs();

test("an existing Codex bot conversation sees the current device login after a hard link detaches", () => {
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
  linkSync(source, join(dataDir, "auth.json.manual-backup"));
  writeFileSync(replacement, "new-login");
  renameSync(replacement, source);

  const resumed = botSession(input, { ...options, linkLogin: true }, "win32");

  expect(resumed.id).toBe("saved-session");
  expect(lstatSync(auth).isSymbolicLink()).toBe(true);
  expect(readFileSync(auth, "utf8")).toBe("new-login");
  writeFileSync(replacement, "renewed-login");
  renameSync(replacement, source);
  expect(readFileSync(auth, "utf8")).toBe("renewed-login");
});
