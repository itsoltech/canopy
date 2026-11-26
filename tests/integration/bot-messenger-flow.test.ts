import { expect, test } from "bun:test";
import { Provider, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { slackMessengerFixture } from "./support/slack-messenger.ts";

async function refusedMessage(
  f: HarnessBots,
  slack: ReturnType<typeof slackMessengerFixture>,
  botId: string,
  advance: () => void,
) {
  slack.refuseNextSend("msg_too_long");
  slack.emit("event-refused", "<@UAPP> a reply that Slack rejects", "300.1", "300.1");
  expect(await eventually(async () => slack.acknowledged.has("event-refused"), Boolean)).toBe(true);
  advance();
  await f.gw.core.messengers.tick();

  const notices = await eventually(
    () => f.read(botId),
    (r) => r.messages.some((m) => m.text.includes("The reply was not sent")),
  );

  expect(notices.messages.some((m) => m.text.includes("The reply was not sent"))).toBe(true);
  expect(notices.messages.some((m) => m.text.startsWith("Replied on Slack") && m.text.endsWith("thread 300.1"))).toBe(
    false,
  );
  slack.emit("event-after-refused", "<@UAPP> another question", "400.1", "400.1");
  expect(await eventually(async () => slack.acknowledged.has("event-after-refused"), Boolean)).toBe(true);
  advance();
  await f.gw.core.messengers.tick();
  expect(
    await eventually(
      async () => slack.sent.length,
      (n) => n === 5,
    ),
  ).toBe(5);
  expect(slack.sent.at(-1)!.get("thread_ts")).toBe("400.1");
  expect(
    await eventually(
      async () => f.query<{ status: string }>("SELECT status FROM messenger_outbound WHERE thread_id='400.1'"),
      (r) => r[0]?.status === "sent",
    ),
  ).toEqual([{ status: "sent" }]);
  const chat = await f.read(botId);
  expect(chat.messages).toContainEqual(
    expect.objectContaining({
      senderId: "activity",
      text: "Replied on Slack · Fixture Slack · channel CGENERAL · thread 400.1",
    }),
  );
}

async function changedInstructions(
  f: HarnessBots,
  slack: ReturnType<typeof slackMessengerFixture>,
  route: ui.BotMessengerRoute,
  advance: () => void,
) {
  const before = f.records().findLast((r) => r.event === "turn" && r.home.includes("/conversations/"))!;
  await f.gw.api.saveBotMessengerRoute({ route: { ...route, instructions: "Answer with the revised instructions." } });
  slack.emit("event-revised", "Continue after the instruction change", "100.4", "100.1");
  expect(await eventually(async () => slack.acknowledged.has("event-revised"), Boolean)).toBe(true);
  advance();
  await f.gw.core.messengers.tick();
  expect(
    await eventually(
      async () => slack.sent.length,
      (n) => n === 2,
    ),
  ).toBe(2);
  const after = f.records().findLast((r) => r.event === "turn" && r.home.includes("/conversations/"))!;

  expect(after.home).toBe(before.home);
  expect(after.session).not.toBe(before.session);
  expect(
    f
      .inputs()
      .at(-1)!
      .parts.map((p) => p.text ?? "")
      .join("\n"),
  ).toContain("Only Safari");
}

test.skipIf(!dockerAvailable)(
  "Socket Mode buffers messages, steers a live harness and keeps conversations private",
  async () => {
    const slack = slackMessengerFixture();
    let clockOffset = 0;

    const f = await harnessBots({
      messengerTransport: slack.transport,
      botClock: () => new Date(Date.now() + clockOffset),
    });

    try {
      const bot = await f.add(Provider.CODEX);
      await f.send(bot.id, "PRIVATE_OWNER_CONTEXT");
      expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");

      const account = (
        await f.gw.api.saveMessengerAccount({
          name: "Fixture Slack",
          appToken: "xapp-fixture",
          botToken: "xoxb-fixture",
        })
      ).account!;

      const route = (
        await f.gw.api.saveBotMessengerRoute({
          route: {
            botId: bot.id,
            accountId: account.id,
            channelIds: ["CGENERAL"],
            userIds: ["UOWNER"],
            directMessages: false,
            mentions: true,
            channelContext: false,
            observe: false,
            delivery: "reply",
            instructions: "Answer the conversation.",
          },
        })
      ).route!;

      const accountConnected = async () =>
        (await f.gw.api.listMessengerAccounts({})).accounts.some(
          (a) => a.id === account.id && a.status === "connected",
        );

      f.gw.core.messengers.start();
      expect(await eventually(accountConnected, Boolean)).toBe(true);

      const modules = async (enabled: string[]) =>
        f.gw.api.updateUserSettings({
          expectedVersion: (await f.gw.api.getSettings({})).user!.version,
          modules: { enabled },
        });

      await modules(["threads"]);
      expect(
        await eventually(
          async () => slack.connected(),
          (count) => count === 0,
        ),
      ).toBe(0);
      slack.emit("while-off", "<@UAPP> dropped", "90.1");
      await modules(["bots", "threads"]);
      expect(
        await eventually(
          async () => slack.connected(),
          (count) => count === 1,
        ),
      ).toBe(1);
      // The server's open callback runs before the gateway commits its Socket Mode Hello.
      expect(await eventually(accountConnected, Boolean)).toBe(true);
      expect(await f.query("SELECT id FROM bot_channel_messages WHERE source_message_id='90.1'")).toEqual([]);

      slack.emit("event-1", "<@UAPP> HOLD:messenger check login", "100.1");
      slack.emit("event-2", "on production", "100.2");
      await eventually(
        async () => slack.acknowledged.size,
        (n) => n === 2,
      );
      expect(slack.acknowledged.size).toBe(2);
      expect(f.inputs()).toHaveLength(1);
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      await eventually(
        async () => f.inputs(),
        (r) => r.some((i) => i.parts.some((p) => p.text?.includes("HOLD:messenger"))),
        10_000,
      );

      const initial = f
        .inputs()
        .at(-1)!
        .parts.map((p) => p.text ?? "")
        .join("\n");

      expect(initial).toContain("HOLD:messenger");
      expect(initial).toContain("on production");
      expect(initial).not.toContain("PRIVATE_OWNER_CONTEXT");

      const active = await f.read(bot.id);
      const listed = async () => (await f.gw.api.listBots({})).bots.find((row) => row.id === bot.id);

      expect(active.working).toBe(false);
      expect(await eventually(listed, (row) => row?.executing === true)).toMatchObject({ executing: true });
      expect(active.statusLine).toContain("Slack");
      expect(active.streamingText).toBe("");
      expect(active.messages.some((m) => m.senderId === "activity" && m.text.includes("2 Slack messages"))).toBe(true);

      slack.emit("event-3", "Only Safari is affected", "100.3");
      await eventually(async () => slack.acknowledged.has("event-3"), Boolean);
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      await eventually(
        async () => f.records(),
        (r) => r.some((p) => p.event === "turn/steer"),
      );

      const consumed = await eventually(
        () => f.query<{ state: string }>("SELECT state FROM bot_channel_messages WHERE source_message_id='100.3'"),
        (r) => r[0]?.state === "consumed",
      );

      expect(consumed[0]?.state).toBe("consumed");
      expect(
        f
          .inputs()
          .at(-1)!
          .parts.some((p) => p.text?.includes("Only Safari")),
      ).toBe(true);

      const turns = await f.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM bot_turns WHERE conversation_id IS NOT NULL",
      );

      expect(turns[0]?.count).toBe("1");

      const privateFollowup = await f.send(bot.id, "PRIVATE_FOLLOWUP_WHILE_SLACK_IS_RUNNING");
      expect(
        await f.query("SELECT status, steer_target_id FROM bot_turns WHERE id = $1", [privateFollowup.turnId]),
      ).toEqual([{ status: "queued", steer_target_id: null }]);
      await f.release("messenger");
      await eventually(
        async () => slack.sent.length,
        (n) => n === 1,
      );
      expect(slack.sent[0]!.get("thread_ts")).toBe("100.1");
      expect(slack.sent[0]!.get("text")).toContain("FIXTURE_OK");
      const privateChat = await f.settled(bot.id);

      expect(await listed()).toMatchObject({ executing: false });
      expect(privateChat.messages.some((m) => m.text === "PRIVATE_FOLLOWUP_WHILE_SLACK_IS_RUNNING")).toBe(true);
      expect(
        privateChat.messages.some((m) => m.text.includes("HOLD:messenger") || m.text.includes("Only Safari")),
      ).toBe(false);

      await changedInstructions(f, slack, route, () => {
        clockOffset += 4000;
      });

      slack.emit("event-4", "<@UAPP> a separate question", "200.1", "200.1");
      await eventually(async () => slack.acknowledged.has("event-4"), Boolean);
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      await eventually(
        async () => slack.sent.length,
        (n) => n === 3,
      );

      const separate = f
        .inputs()
        .at(-1)!
        .parts.map((p) => p.text ?? "")
        .join("\n");

      expect(separate).toContain("a separate question");
      expect(separate).not.toContain("Only Safari");
      expect(separate).not.toContain("PRIVATE_OWNER_CONTEXT");
      await refusedMessage(f, slack, bot.id, () => {
        clockOffset += 4000;
      });

      slack.emit("event-revoked", "<@UAPP> HOLD:revoked another active request", "500.1", "500.1");
      expect(await eventually(async () => slack.acknowledged.has("event-revoked"), Boolean)).toBe(true);
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      expect(await eventually(listed, (row) => row?.executing === true)).toMatchObject({ executing: true });

      const held = (
        await f.query<{ id: string }>("SELECT id FROM bot_turns WHERE bot_id=$1 AND status='running'", [bot.id])
      )[0]!;

      await f.gw.api.saveBotMessengerRoute({ route: { ...route, channelIds: ["COTHER"] } });
      expect(await listed()).toMatchObject({ executing: false });
      expect(await f.query("SELECT status FROM bot_turns WHERE id=$1", [held.id])).toEqual([{ status: "running" }]);
      await f.release("revoked");
      const settled = (status: string) => ["failed", "interrupted"].includes(status);

      const [stopped] = await eventually(
        () => f.query<{ status: string }>("SELECT status FROM bot_turns WHERE id=$1", [held.id]),
        ([turn]) => !!turn && settled(turn.status),
      );

      expect(stopped && settled(stopped.status)).toBe(true);
    } finally {
      await f.close();
      await slack.close();
    }
  },
  60_000,
);
