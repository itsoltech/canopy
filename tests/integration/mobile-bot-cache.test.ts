import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { applyBotConversation, answerLiveBotApproval } from "@canopy/domain/bot-snapshot";
import { botViewKey } from "@canopy/domain/bot-cache";
import { PersistentBotCache, clearPairedHistory } from "../../apps/mobile/src/storage/bot-cache.ts";
import { PersistentThreadCache } from "../../apps/mobile/src/storage/thread-cache.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { DiskThreadStorage } from "./support/thread-cache.ts";
import { botsSuite, reply, tool } from "./support/bots.ts";
import { eventually, SERVICE_TOKEN } from "./support/gateway.ts";

const directory = tempDirs();

const view = (id: string, text = id) =>
  create(bots.BotCachedViewSchema, {
    key: botViewKey("chat", id),
    conversation: { bot: { id, configuration: { name: text } }, cursor: `${crypto.randomUUID()}:1` },
  });

describe("durable bot chat and exchange cache", () => {
  test("restart retains state, count/byte LRU evicts, and corrupt or wrong-identity files fall back", async () => {
    const storage = new DiskThreadStorage(directory("canopy-bot-lru-"));
    const limits = { count: 2, bytes: 4096, entry: 2048 };
    let cache = new PersistentBotCache(storage, limits);
    const first = view("first");
    await cache.save(first);
    await cache.save(view("second"));
    cache = new PersistentBotCache(storage, limits);
    expect(await cache.load(first.key)).toEqual(first);
    await cache.save(view("third"));
    cache = new PersistentBotCache(storage, limits);
    expect(await cache.load("chat_second")).toBeUndefined();
    expect(await cache.load(first.key)).toEqual(first);
    await storage.write("chat_corrupt", new Uint8Array([255, 255]));
    await storage.write("chat_mismatch", toBinary(bots.BotCachedViewSchema, { ...first, key: "chat_mismatch" }));
    expect(await cache.load("chat_corrupt")).toBeUndefined();
    expect(await cache.load("chat_mismatch")).toBeUndefined();
    await cache.save(view("oversized", "x".repeat(5000)));
    expect((await storage.list()).some((f) => f.id === "chat_oversized")).toBe(false);
    cache = new PersistentBotCache(storage, { ...limits, bytes: 1800 });
    await cache.save(view("large-a", "a".repeat(1000)));
    await cache.save(view("large-b", "b".repeat(1000)));
    expect((await storage.list()).reduce((sum, f) => sum + f.bytes, 0)).toBeLessThanOrEqual(1800);
    expect(await new PersistentBotCache(storage).load("chat_large-a")).toBeUndefined();
  });

  test("archive, deletion or a move removes both chats and exchanges, including legacy exchanges", async () => {
    const storage = new DiskThreadStorage(directory("canopy-bot-reconcile-"));
    const cache = new PersistentBotCache(storage);
    const chat = view("bot");

    const exchange = create(bots.BotCachedViewSchema, {
      key: botViewKey("exchange", "exchange"),
      exchange: { cursor: "checkpoint", messages: [{ id: "message", botId: "bot", seq: 1n, text: "Hello" }] },
    });

    await cache.save(chat);
    await cache.save(exchange);
    expect(await new PersistentBotCache(storage).load(exchange.key)).toEqual(exchange);
    await cache.reconcile([create(bots.BotSchema, { id: "bot", archived: true })]);
    expect(cache.peek(chat.key)).toBeUndefined();
    expect(cache.peek(exchange.key)).toBeUndefined();
    expect(await storage.list()).toHaveLength(0);
    await cache.save(chat);
    await cache.save(exchange);
    expect(await storage.list()).toHaveLength(0);
    await cache.reconcile([create(bots.BotSchema, { id: "bot" })]);
    await cache.save(chat);
    await cache.save(exchange);
    // A moved bot has a new qualified identity; the old source disappears from the directory.
    await cache.reconcile([create(bots.BotSchema, { id: "new_bot" })]);
    expect(await new PersistentBotCache(storage).load(chat.key)).toBeUndefined();
    expect(await new PersistentBotCache(storage).load(exchange.key)).toBeUndefined();
  });

  test("unpair fences both caches before waiting for an in-flight disk write", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    class SlowStorage extends DiskThreadStorage {
      override async write(id: string, bytes: Uint8Array) {
        entered.resolve();
        await release.promise;
        await super.write(id, bytes);
      }
    }

    const disk = new SlowStorage(directory("canopy-bot-unpair-"));
    const threadDisk = new DiskThreadStorage(directory("canopy-thread-unpair-"));
    const cache = new PersistentBotCache(disk);
    const threadCache = new PersistentThreadCache(threadDisk);
    const state = view("bot");
    const thread = create(ui.ThreadSnapshotSchema, { thread: { id: "thread" } });
    await threadCache.save(thread);
    const writing = cache.save(state);
    await entered.promise;
    const clearing = clearPairedHistory([cache, threadCache], () => Promise.resolve());
    expect(cache.peek(state.key)).toBeUndefined();
    expect(threadCache.peek("thread")).toBeUndefined();
    release.resolve();
    await writing;
    expect(await clearing).toBe(true);
    await cache.save(state);
    await threadCache.save(thread);
    expect(await disk.list()).toHaveLength(0);
    expect(await threadDisk.list()).toHaveLength(0);
  });
});

describe.skipIf(!dockerAvailable)("paired device bot history and approval safety", () => {
  const { suite, add, send } = botsSuite();
  let network: NetworkAccess;
  let unmount: () => void;

  beforeAll(async () => {
    network = new NetworkAccess({
      store: new ComputerStore(suite.gw.runtime, suite.gw.userId, suite.gw.secretsKey),
      host: "127.0.0.1",
    });
    suite.gw.core.network = network;
    unmount = mountMobileNetwork(suite.gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  });

  afterAll(async () => {
    unmount?.();
    await network?.close();
  });

  test("cached approvals wait for live confirmation, credentials never reach disk, and revoke clears both caches", async () => {
    const routes = suite.gw.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();
    const invitation = await suite.gw.api.createMobilePairing({});

    const paired = await routedMobileClient({ connection: routes, transport }).pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Bot cache test",
      platform: "android",
    });

    const client = routedMobileClient({ connection: routes, token: paired.deviceToken, transport });
    const secret = `synthetic-${crypto.randomUUID()}`;
    await suite.gw.api.saveBotMcpServer({
      name: "Private connection",
      url: "https://example.invalid/mcp",
      transport: "http",
      headers: { authorization: secret },
    });
    const bot = await add("Approval cache");
    suite.model = async (input) =>
      input.messages.at(-1)?.role === "tool"
        ? reply("Done")
        : tool("ask_user", { question: "Continue?", options: ["Yes", "No"] });
    await send(bot.id, "Ask before continuing");

    const pending = await eventually(
      () => suite.current.bots.run((s) => s.conversation(suite.gw.userId, bot.id)),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    expect(pending.approvals.some((a) => a.status === "pending")).toBe(true);

    const open = async (cursor = "") => {
      const abort = new AbortController();

      try {
        for await (const state of client.api.watchBotConversation(
          { botId: bot.id, incremental: true, cursor },
          { signal: abort.signal, timeoutMs: 5000 },
        ))
          return state;
        throw new Error("No bot snapshot");
      } finally {
        abort.abort();
      }
    };

    const disk = new DiskThreadStorage(directory("canopy-bot-device-"));
    let cache = new PersistentBotCache(disk);
    const key = botViewKey("chat", bot.id);
    let state = applyBotConversation(undefined, await open());
    await cache.save(create(bots.BotCachedViewSchema, { key, conversation: state }));
    cache = new PersistentBotCache(disk);
    state = (await cache.load(key))!.conversation!;
    const card = state.approvals.find((a) => a.status === "pending")!;
    const request = create(bots.AnswerBotApprovalRequestSchema, { approvalId: card.id, approve: true, answer: "Yes" });
    await expect(answerLiveBotApproval(state, request, false, (r) => client.api.answerBotApproval(r))).rejects.toThrow(
      "syncing",
    );
    await expect(
      answerLiveBotApproval(state, { ...request, ruleOptionId: "cached-rule" }, false, (r) =>
        client.api.answerBotApproval(r),
      ),
    ).rejects.toThrow("syncing");
    expect((await open()).approvals.find((a) => a.id === card.id)?.status).toBe("pending");
    const delta = await open(state.cursor);
    expect(delta.delta).toBe(true);
    state = applyBotConversation(state, delta);
    await answerLiveBotApproval(state, request, true, (r) => client.api.answerBotApproval(r));
    state = applyBotConversation(state, await open(state.cursor));
    expect(state.approvals.find((a) => a.id === card.id)?.status).not.toBe("pending");
    await expect(answerLiveBotApproval(state, request, true, (r) => client.api.answerBotApproval(r))).rejects.toThrow();
    await cache.save(create(bots.BotCachedViewSchema, { key, conversation: state }));

    for (const file of await disk.list()) {
      const bytes = Buffer.from(await disk.read(file.name));
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from("fixture-secret"))).toBe(false);
      expect(bytes.includes(Buffer.from(paired.deviceToken))).toBe(false);
    }

    const threadDisk = new DiskThreadStorage(directory("canopy-bot-device-threads-"));
    const threadCache = new PersistentThreadCache(threadDisk);
    await threadCache.save(create(ui.ThreadSnapshotSchema, { thread: { id: "thread" } }));
    await suite.gw.api.revokeMobileDevice({ id: paired.device!.id });
    let revoked = false;

    try {
      await open(state.cursor);
    } catch (error) {
      revoked = ConnectError.from(error).code === Code.Unauthenticated;
    }

    expect(revoked).toBe(true);
    expect(await clearPairedHistory([threadCache, cache], () => Promise.resolve())).toBe(true);
    await cache.save(create(bots.BotCachedViewSchema, { key, conversation: state }));
    expect(cache.peek(key)).toBeUndefined();
    expect(await new PersistentBotCache(disk).load(key)).toBeUndefined();
    expect(await disk.list()).toHaveLength(0);
    expect(await threadDisk.list()).toHaveLength(0);
  }, 30000);
});
