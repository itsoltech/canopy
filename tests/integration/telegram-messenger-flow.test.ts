import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually } from "./support/gateway.ts";
import { harnessBots } from "./support/harness-bots.ts";
import { telegramMessengerFixture, telegramToken } from "./support/telegram-messenger.ts";

test.skipIf(!dockerAvailable)(
  "Telegram replies thread to the mention, continue on a reply to the bot and keep DMs separate",
  async () => {
    const telegram = telegramMessengerFixture();
    let clockOffset = 0;

    const f = await harnessBots({
      messengerTransport: telegram.transport,
      botClock: () => new Date(Date.now() + clockOffset),
    });

    const flush = async () => {
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
    };

    try {
      const bot = await f.add(Provider.CODEX);

      const account = (
        await f.gw.api.saveMessengerAccount({ name: "Fixture Telegram", provider: "telegram", botToken: telegramToken })
      ).account!;

      expect(account).toMatchObject({ provider: "telegram", externalId: "telegram:777" });

      const refused = await f.gw.api
        .saveBotMessengerRoute({
          route: {
            botId: bot.id,
            accountId: account.id,
            channelIds: ["CGENERAL"],
            userIds: ["42"],
            directMessages: false,
            mentions: true,
            observe: false,
            delivery: "reply",
            instructions: "",
          },
        })
        .then(
          () => "",
          (error: Error) => String(error),
        );

      expect(refused).toContain("Use Telegram channel IDs");

      const route = (
        await f.gw.api.saveBotMessengerRoute({
          route: {
            botId: bot.id,
            accountId: account.id,
            channelIds: ["-100200"],
            userIds: ["42"],
            directMessages: true,
            mentions: true,
            observe: false,
            delivery: "reply",
            instructions: "Answer the conversation.",
          },
        })
      ).route!;

      // Shared channel background reads Slack history, so other providers never enable it.
      expect(route.channelContext).toBe(false);

      f.gw.core.messengers.start();
      expect(
        await eventually(
          async () => (await f.gw.api.listMessengerAccounts({})).accounts.find((a) => a.id === account.id)?.status,
          (status) => status === "connected",
        ),
      ).toBe("connected");

      const mention = telegram.emit({ chat: -100200, from: 42, text: "is the deploy done?", mention: true });
      await eventually(async () => telegram.acknowledged(mention.updateId), Boolean);
      await flush();
      await eventually(
        async () => telegram.sent.length,
        (n) => n === 1,
      );

      expect(telegram.sent[0]).toMatchObject({
        chat_id: "-100200",
        reply_parameters: { message_id: mention.messageId },
      });
      expect(String(telegram.sent[0]!["text"])).toContain("FIXTURE_OK");

      const [first] = await eventually(
        () =>
          f.query<{ conversation_id: string; message_id: string }>(
            "SELECT conversation_id,message_id FROM messenger_outbound WHERE status='sent'",
          ),
        (rows) => rows.length === 1,
      );

      // A plain reply to the bot's message, without a mention, continues the same conversation.
      const followup = telegram.emit({
        chat: -100200,
        from: 42,
        text: "and staging?",
        replyTo: { id: Number(first!.message_id), from: 777 },
      });

      await eventually(async () => telegram.acknowledged(followup.updateId), Boolean);
      await flush();
      await eventually(
        async () => telegram.sent.length,
        (n) => n === 2,
      );

      expect(telegram.sent[1]).toMatchObject({ reply_parameters: { message_id: mention.messageId } });
      expect(await f.query("SELECT DISTINCT conversation_id FROM bot_turns WHERE conversation_id IS NOT NULL")).toEqual(
        [{ conversation_id: first!.conversation_id }],
      );
      expect(
        f
          .inputs()
          .at(-1)!
          .parts.map((p) => p.text ?? "")
          .join("\n"),
      ).toContain("and staging?");

      const direct = telegram.emit({ chat: 42, from: 42, text: "a private question" });
      await eventually(async () => telegram.acknowledged(direct.updateId), Boolean);
      await flush();
      await eventually(
        async () => telegram.sent.length,
        (n) => n === 3,
      );

      expect(telegram.sent[2]).toMatchObject({ chat_id: "42" });
      expect(telegram.sent[2]!["reply_parameters"]).toBeUndefined();
      expect(await f.query("SELECT direct FROM bot_channel_conversations WHERE channel_id='42'")).toEqual([
        { direct: true },
      ]);

      const outsider = telegram.emit({ chat: -100200, from: 43, text: "let me in", mention: true });
      await eventually(async () => telegram.acknowledged(outsider.updateId), Boolean);
      await flush();
      expect(await f.query("SELECT id FROM bot_channel_messages WHERE author_id='43'")).toEqual([]);

      const chat = await f.read(bot.id);
      expect(chat.messages.some((m) => m.text.startsWith("Replied on Telegram · Fixture Telegram"))).toBe(true);
    } finally {
      await f.close();
      await telegram.close();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "a file sent with send_attachment leaves with the conversation reply, not the owner's chat",
  async () => {
    const telegram = telegramMessengerFixture();
    let clockOffset = 0;

    const f = await harnessBots({
      messengerTransport: telegram.transport,
      botClock: () => new Date(Date.now() + clockOffset),
    });

    const reply = async (count: number) => {
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      await eventually(
        async () => telegram.sent.length,
        (n) => n === count,
      );
    };

    try {
      const bot = await f.add(Provider.CODEX);

      const account = (
        await f.gw.api.saveMessengerAccount({ name: "Fixture Telegram", provider: "telegram", botToken: telegramToken })
      ).account!;

      await f.gw.api.saveBotMessengerRoute({
        route: {
          botId: bot.id,
          accountId: account.id,
          channelIds: ["-100200"],
          userIds: ["42"],
          mentions: true,
          delivery: "reply",
          instructions: "Prepare requested files.",
        },
      });
      f.gw.core.messengers.start();

      const request = telegram.emit({
        chat: -100200,
        from: 42,
        text: 'TOOL:write_file\nARGS:{"path":"report.txt","text":"Weekly report"}',
        mention: true,
      });

      await eventually(async () => telegram.acknowledged(request.updateId), Boolean);
      await reply(1);

      const [first] = await eventually(
        () => f.query<{ message_id: string }>("SELECT message_id FROM messenger_outbound WHERE status='sent'"),
        (rows) => rows.length === 1,
      );

      const send = telegram.emit({
        chat: -100200,
        from: 42,
        text: 'TOOL:send_attachment\nARGS:{"path":"report.txt"}',
        replyTo: { id: Number(first!.message_id), from: 777 },
      });

      await eventually(async () => telegram.acknowledged(send.updateId), Boolean);
      await reply(3);

      expect(telegram.sent.map((body) => body["method"])).toEqual(["sendMessage", "sendMessage", "sendDocument"]);
      expect(telegram.sent[2]).toMatchObject({
        chat_id: "-100200",
        file: "report.txt",
        bytes: "Weekly report".length,
        reply_parameters: { message_id: request.messageId },
      });

      // The file belongs to the external conversation; the owner's private chat gets no copy.
      const chat = await f.read(bot.id);
      expect(chat.messages.some((m) => m.attachments.length > 0)).toBe(false);
    } finally {
      await f.close();
      await telegram.close();
    }
  },
  60_000,
);
