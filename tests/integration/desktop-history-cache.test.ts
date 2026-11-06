import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { DesktopHistoryCache } from "../../apps/desktop/src/history-cache.ts";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { applyBotConversation } from "@canopy/domain/bot-snapshot";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { stat } from "node:fs/promises";

describe.skipIf(!dockerAvailable)("desktop private history across restarts", () => {
  const directory = tempDir("desktop-history-");
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60000);
  afterAll(async () => {
    await gateway?.close();
  });

  const openThread = async (threadId: string, cursor = "") => {
    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(
        { threadId, cursor, incremental: true },
        { signal: abort.signal },
      ))
        return update;
      throw new Error("Missing snapshot");
    } finally {
      abort.abort();
    }
  };

  const openBot = async (botId: string, cursor = "") => {
    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchBotConversation(
        { botId, cursor, incremental: true },
        { signal: abort.signal },
      ))
        return update;
      throw new Error("Missing conversation");
    } finally {
      abort.abort();
    }
  };

  test("disk reload and gateway restart resume thread and bot checkpoints without replay", async () => {
    const project = (await gateway.api.createProject({ name: "Desktop persistence" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project.id, workerId: gateway.workerId, rootPath: "/repo/cache" })
    ).workspace!;

    const thread = (
      await gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    const bot = (
      await gateway.api.createBot({
        configuration: {
          name: "Persistent bot",
          shape: "round",
          color: "#2288aa",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
        },
        clientRequestId: crypto.randomUUID(),
      })
    ).bot!;

    const snapshot = applyThreadUpdate(undefined, await openThread(thread.id));
    const conversation = await openBot(bot.id);
    const cache = new DesktopHistoryCache(directory);
    const key = `thread_${thread.id}`;
    const { generation } = await cache.read(key);
    await cache.write(generation, key, toBinary(ui.ThreadSnapshotSchema, snapshot));
    await cache.write(
      generation,
      `chat_${bot.id}`,
      toBinary(bots.BotCachedViewSchema, create(bots.BotCachedViewSchema, { key: `chat_${bot.id}`, conversation })),
    );
    expect((await stat(`${directory}/${key}.bin`)).mode & 0o777).toBe(0o600);

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage });
    const restarted = new DesktopHistoryCache(directory);
    const held = fromBinary(ui.ThreadSnapshotSchema, (await restarted.read(key)).bytes!);
    const delta = await openThread(thread.id, held.cursor);
    expect(delta.change.case).toBe("delta");
    expect(applyThreadUpdate(held, delta)).toEqual(applyThreadUpdate(undefined, await openThread(thread.id)));

    const botState = fromBinary(
      bots.BotCachedViewSchema,
      (await restarted.read(`chat_${bot.id}`)).bytes!,
    ).conversation!;

    const botDelta = await openBot(bot.id, botState.cursor);
    expect(botDelta.delta).toBe(true);
    expect(botDelta.messages).toHaveLength(0);
    expect(applyBotConversation(botState, botDelta)).toEqual(await openBot(bot.id));
    const freshGeneration = (await restarted.read(key)).generation;
    await restarted.reconcileBots(freshGeneration, []);
    expect((await restarted.read(`chat_${bot.id}`)).bytes).toBeUndefined();
    expect((await restarted.read(key)).bytes).toBeDefined();
    await restarted.clear();
    await restarted.write(generation, key, toBinary(ui.ThreadSnapshotSchema, snapshot));
    expect((await restarted.read(key)).bytes).toBeUndefined();
  }, 60000);
});

test("desktop history rejects path traversal, corrupt entries and revoked late writes; evicts LRU", async () => {
  const directory = tempDir("desktop-history-budget-");
  const cache = new DesktopHistoryCache(directory, { count: 1, bytes: 1024, entry: 1024 });
  await expect(cache.read("../outside")).rejects.toThrow();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const { generation } = await cache.read(`thread_${first}`);

  const bytes = (id: string) =>
    toBinary(ui.ThreadSnapshotSchema, create(ui.ThreadSnapshotSchema, { thread: { id }, cursor: "checkpoint" }));

  await cache.write(generation, `thread_${first}`, bytes(first));
  await cache.write(generation, `thread_${second}`, bytes(second));
  expect((await cache.read(`thread_${first}`)).bytes).toBeUndefined();
  expect((await cache.read(`thread_${second}`)).bytes).toBeDefined();
  const revoked = cache.clear();
  await cache.write(generation, `thread_${first}`, bytes(first));
  await revoked;
  expect((await new DesktopHistoryCache(directory).read(`thread_${first}`)).bytes).toBeUndefined();
});
