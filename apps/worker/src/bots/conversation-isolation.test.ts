import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { existsSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { botSession } from "./session.ts";
import { BOT_RETENTION_MS, cleanupBotWorkspaces } from "./workspace.ts";
import { BotSteering } from "./steering.ts";
import { Journal } from "../journal/index.ts";
import { ManagedRuntime } from "effect";

const tempDir = tempDirs();

test("external conversations isolate session history and files from the private bot and each other", async () => {
  const root = tempDir("canopy-bot-conversations-");

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    provider: Provider.CODEX,
    profileId: "fixture",
    configurationKey: "same-settings",
  });

  const options = { dataDir: root, sourceHome: "", linkLogin: false };
  const privateSession = botSession(input, options);
  privateSession.save("private-session");
  privateSession.workspace.write("private.txt", Buffer.from("private"));
  const externalInput = create(RunBotTurnSchema, { ...input, conversationId: crypto.randomUUID() });
  const external = botSession(externalInput, options);
  expect(external.id).toBe("");
  expect(external.home).not.toBe(privateSession.home);
  expect(external.workspace.list()).toEqual([]);
  external.save("external-session");
  external.workspace.write("shared.txt", Buffer.from("external conversation"));

  const other = botSession(
    create(RunBotTurnSchema, { ...externalInput, conversationId: crypto.randomUUID() }),
    options,
  );

  expect(other.home).not.toBe(external.home);
  expect(other.id).toBe("");
  expect(other.workspace.list()).toEqual([]);
  expect(botSession(input, options).id).toBe("private-session");
  expect(botSession(externalInput, options).id).toBe("external-session");
  const claude = botSession(create(RunBotTurnSchema, { ...externalInput, provider: Provider.CLAUDE }), options);
  expect(claude.id).toBe("");
  expect(claude.home).not.toBe(external.home);
  expect(claude.workspace.path).toBe(external.workspace.path);
  expect((await claude.workspace.read("shared.txt")).toString()).toBe("external conversation");
  expect(privateSession.workspace.list().map((file) => file.name)).toEqual(["private.txt"]);
  expect(() => botSession(create(RunBotTurnSchema, { ...input, conversationId: "../private" }), options)).toThrow();
  const linkedId = crypto.randomUUID();
  symlinkSync(join(root, "bots", input.botId), join(root, "bots", input.botId, "conversations", linkedId));
  expect(() => botSession(create(RunBotTurnSchema, { ...input, conversationId: linkedId }), options)).toThrow();
});

test("external workspace retention skips live conversations and removes expired files", () => {
  const root = tempDir("canopy-bot-conversation-retention-");

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    provider: Provider.CODEX,
    conversationId: crypto.randomUUID(),
  });

  const session = botSession(input, { dataDir: root, sourceHome: "", linkLogin: false });
  const release = session.workspace.hold();
  const future = Date.now() + BOT_RETENTION_MS + 1000;
  cleanupBotWorkspaces(root, future);
  expect(existsSync(session.workspace.path)).toBe(true);
  release();
  utimesSync(session.workspace.path, new Date(0), new Date(0));
  cleanupBotWorkspaces(root, future);
  expect(existsSync(session.workspace.path)).toBe(false);
});

test("worker restart rebuilds an uncertain native session, preserves applied notices and never replays input", async () => {
  const root = tempDir("canopy-bot-steer-restart-");

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    provider: Provider.CODEX,
    conversationId: crypto.randomUUID(),
  });

  const options = { dataDir: root, sourceHome: "", linkLogin: false };
  const session = botSession(input, options);
  session.save("native-session");
  let runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

  const steering = new BotSteering(session, async (event) => {
    await runtime.runPromise(Journal.use((j) => j.append(input.botId, { ...event, turnId: input.turnId })));
  });

  let writes = 0;
  steering.ready(async () => {
    writes++;
  });
  const appliedId = crypto.randomUUID();
  const unknownId = crypto.randomUUID();

  try {
    expect(steering.submit(appliedId, "Known input")).toBe("queued");
    await steering.applied(appliedId);
    expect(steering.submit(appliedId, "Duplicate input")).toBe("delivered");
    expect(writes).toBe(1);
    expect(botSession(input, options).id).toBe("native-session");
    expect(steering.submit(unknownId, "Unknown native write")).toBe("queued");
    expect(botSession(input, options).id).toBe("");
    const before = await runtime.runPromise(Journal.use((j) => j.pending(new Map())));
    await runtime.dispose();
    // A new process has only the journal and cache. It does not recreate the transient sender or input queue.
    runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
    const after = await runtime.runPromise(Journal.use((j) => j.pending(new Map())));
    expect(after.map((event) => event.eventId)).toEqual(before.map((event) => event.eventId));
    expect(
      after.filter((event) => event.body.case === "notice" && event.body.value.code === "bot_steer_applied"),
    ).toHaveLength(1);
    expect(writes).toBe(2);
    expect(botSession(input, options).id).toBe("");
  } finally {
    await runtime.dispose();
  }
});
