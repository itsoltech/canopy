import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bots } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { botEntries, layoutChat } from "@canopy/domain/bot-chat";
import { applyBotConversation } from "@canopy/domain/bot-snapshot";
import { prependBotPage } from "@canopy/domain/history-pages";
import { seedBotChatHistory } from "./support/bot-chat-history.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot latest messages through the gateway and shared chat projection", () => {
  let gateway: TestGateway;
  let bot: string;

  beforeAll(async () => {
    gateway = await startTestGateway();
    ({ bot } = await seedBotChatHistory(gateway));
  }, 60000);
  afterAll(async () => {
    await gateway?.close();
  });

  async function open(cursor = "", beforeSeq = 0n) {
    const abort = new AbortController();

    try {
      for await (const snapshot of gateway.api.watchBotConversation(
        { botId: bot, incremental: true, pageSize: 50, cursor, beforeSeq },
        { signal: abort.signal, timeoutMs: 5000 },
      ))
        return snapshot;
      throw new Error("Missing bot conversation");
    } finally {
      abort.abort();
    }
  }

  function latestVisible(snapshot: bots.BotConversation) {
    return layoutChat({
      entries: botEntries(snapshot).slice(-100),
      participants: new Map(),
      me: "me",
      kind: "direct",
    }).at(-1);
  }

  test("the bounded initial page includes the sidebar's last routine reply after forwarded approvals", async () => {
    const snapshot = await open();
    const sidebar = (await gateway.api.listBots({})).bots.find((b) => b.id === bot)!;
    expect(snapshot.messages).toHaveLength(50);
    expect(snapshot.historyHasMore).toBe(true);
    expect(snapshot.approvals).toHaveLength(105);
    expect(snapshot.approvals.every((a) => a.threadId && a.status === "approved")).toBe(true);
    expect(snapshot.messages.at(-1)).toEqual(sidebar.lastMessage!);
    expect(latestVisible(snapshot)).toMatchObject({
      kind: "message",
      id: sidebar.lastMessage!.id,
      message: { text: "Morning brief: lessons are ready" },
    });
  });

  test("cached deltas, later user and bot messages, and older pages keep the same latest reply", async () => {
    let state = await open();

    const sent = await gateway.api.sendBotMessage({
      botId: bot,
      text: "Please do not start anything else",
      clientRequestId: crypto.randomUUID(),
    });

    const userDelta = await open(state.cursor);
    expect(userDelta.delta).toBe(true);
    expect(userDelta.messages).toHaveLength(1);
    state = applyBotConversation(state, userDelta);
    expect(latestVisible(state)).toMatchObject({
      kind: "message",
      message: { text: "Please do not start anything else" },
    });
    const page = await open(state.cursor, state.historyBeforeSeq);
    await gateway.core.linkedAgents.query(
      `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text)
      VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'answer',$1,'user','Understood, I will not start anything')`,
      [bot, sent.turnId],
    );
    await gateway.core.linkedAgents.query("UPDATE bot_turns SET status='completed' WHERE id=$1::uuid", [sent.turnId]);
    state = applyBotConversation(state, await open(state.cursor));
    state = prependBotPage(state, page);
    expect(state.historyHasMore).toBe(false);
    const latest = (await gateway.api.listBots({})).bots.find((b) => b.id === bot)!.lastMessage!;
    expect(latestVisible(state)).toMatchObject({ kind: "message", id: latest.id, message: { text: latest.text } });
    const unchanged = await open(state.cursor);
    expect(unchanged.messages).toHaveLength(0);
    expect(latestVisible(applyBotConversation(state, unchanged))).toEqual(latestVisible(state));
  });
});
