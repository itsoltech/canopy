import { afterEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { MessengerError } from "../../apps/gateway/src/messengers/messenger-error.ts";
import type { MessengerEvent, OutboundMessage } from "../../apps/gateway/src/messengers/types.ts";
import { telegramAdapter } from "../../apps/gateway/src/messengers/telegram.ts";
import { telegramMessengerFixture, telegramToken } from "./support/telegram-messenger.ts";

const credentials = { appToken: "", botToken: telegramToken };
const fixtures: ReturnType<typeof telegramMessengerFixture>[] = [];
const runs: { controller: AbortController; done: Promise<void> }[] = [];

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Telegram fixture deadline");
    await delay(5);
  }
}

function fixture(options?: { webhook?: string }) {
  const value = telegramMessengerFixture(options);
  fixtures.push(value);

  return value;
}

function run(f: ReturnType<typeof fixture>, onEvent: (event: MessengerEvent) => Promise<void>) {
  const controller = new AbortController();
  const statuses: string[] = [];

  const done = telegramAdapter.run(
    {
      accountId: "account",
      credentials,
      botUserId: "777",
      transport: f.transport,
      onEvent,
      onStatus: async (status) => {
        statuses.push(status);
      },
    },
    controller.signal,
  );

  runs.push({ controller, done });

  return { statuses, done };
}

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: "outbound",
  accountId: "account",
  channelId: "-100200",
  threadId: "",
  text: "",
  ...overrides,
});

afterEach(async () => {
  for (const { controller, done } of runs.splice(0)) {
    controller.abort();
    await done.catch(() => {});
  }

  for (const f of fixtures.splice(0)) await f.close();
});

describe("Telegram messenger adapter", () => {
  test("validation identifies the bot and refuses a token that is bound to a webhook", async () => {
    const f = fixture();
    const signal = AbortSignal.timeout(2000);

    expect(await telegramAdapter.validate(credentials, signal, f.transport)).toEqual({
      externalId: "telegram:777",
      botUserId: "777",
    });

    const hooked = fixture({ webhook: "https://example.invalid/hook" });

    const refused = await telegramAdapter.validate(credentials, signal, hooked.transport).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(refused).toBeInstanceOf(MessengerError);
    expect(refused).toMatchObject({ kind: "configuration", code: "webhook_active" });
  });

  test("an update is confirmed only after the gateway accepted it", async () => {
    const f = fixture();
    const events: MessengerEvent[] = [];
    let failOnce = true;

    const { statuses } = run(f, async (event) => {
      if (failOnce) {
        failOnce = false;

        throw new Error("lease lost");
      }

      events.push(event);
    });

    const first = f.emit({ chat: -100200, from: 42, text: "deploy status?", mention: true });
    await until(() => events.length === 1);
    expect(statuses).toContain("retrying");
    // The failed delivery was not confirmed, so Telegram redelivered the same update after reconnecting.
    expect(events[0]).toMatchObject({ id: String(first.updateId), messageId: String(first.messageId) });

    const direct = f.emit({ chat: 42, from: 42, text: "private question" });
    const followup = f.emit({ chat: -100200, from: 42, text: "and staging", replyTo: { id: 9001, from: 777 } });
    const edit = f.emit({ chat: -100200, from: 42, text: "deploy status now?", edit: first.messageId });
    const other = f.emit({ chat: -100200, from: 43, text: "unrelated", replyTo: { id: first.messageId, from: 42 } });
    await until(() => events.length === 5 && f.acknowledged(other.updateId));

    expect(events[0]).toMatchObject({ channelId: "-100200", authorId: "42", mention: true, direct: false });
    expect(events[1]).toMatchObject({ id: String(direct.updateId), channelId: "42", direct: true, mention: false });
    // Replying to the bot addresses it and names the message being answered.
    expect(events[2]).toMatchObject({ id: String(followup.updateId), mention: true, replyTo: "9001", threadId: "" });
    expect(events[3]).toMatchObject({ id: String(edit.updateId), kind: "edit", messageId: String(first.messageId) });
    expect(events[4]).toMatchObject({ mention: false, replyTo: String(first.messageId) });
  });

  test("replies are formatted, threaded and split without resending confirmed parts", async () => {
    const f = fixture();
    const signal = AbortSignal.timeout(2000);

    const confirmed = await telegramAdapter.send(
      credentials,
      message({ threadId: "321", text: "**Done** with `x<y` and [docs](https://example.com/a?b=1&c=2)" }),
      signal,
      f.transport,
    );

    expect(confirmed).toEqual({ channelId: "-100200", messageId: expect.stringMatching(/^\d+$/) });
    expect(f.sent[0]).toMatchObject({
      chat_id: "-100200",
      parse_mode: "HTML",
      text: '<b>Done</b> with <code>x&lt;y</code> and <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
      reply_parameters: { message_id: 321, allow_sending_without_reply: true },
    });

    f.refuseNextSend(400, "Bad Request: can't parse entities: unsupported start tag");
    await telegramAdapter.send(credentials, message({ text: "plain *fallback*" }), signal, f.transport);
    // The refused formatted message was not sent, so the plain text resend cannot duplicate it.
    expect(f.sent.slice(1).map((body) => body["parse_mode"] ?? "plain")).toEqual(["HTML", "plain"]);
    expect(f.sent[2]).toMatchObject({ text: "plain *fallback*" });

    const long = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    f.sent.length = 0;
    await telegramAdapter.send(credentials, message({ text: long }), signal, f.transport);
    expect(f.sent.map((body) => String(body["text"]).length)).toEqual([3000, 3000]);

    f.refuseNextSend(429, "Too Many Requests", 7);

    const limited = await telegramAdapter.send(credentials, message({ text: "hi" }), signal, f.transport).then(
      () => undefined,
      (error: Error) => error,
    );

    // Nothing was sent, so the outbox may retry after Telegram's delay.
    expect(limited).toMatchObject({ kind: "retryable", retryAfterMs: 7000 });
  });

  test("a failed later part reports an unknown outcome instead of a retry", async () => {
    const f = fixture();
    f.acceptNextSend();
    f.refuseNextSend(429, "Too Many Requests", 3);

    const failure = await telegramAdapter
      .send(
        credentials,
        message({ text: `${"a".repeat(3000)}\n${"b".repeat(3000)}` }),
        AbortSignal.timeout(2000),
        f.transport,
      )
      .then(
        () => undefined,
        (error: Error) => error,
      );

    // The first part is visible in the chat, so retrying would post it twice.
    expect(f.sent).toHaveLength(2);
    expect(failure).toMatchObject({ kind: "unknown_write", code: "partial_send" });
  });
});
