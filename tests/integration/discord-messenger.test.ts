import { afterEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { discordAdapter } from "../../apps/gateway/src/messengers/discord.ts";
import type { MessengerEvent } from "../../apps/gateway/src/messengers/types.ts";
import {
  discordBot,
  discordChannel,
  discordMessengerFixture,
  discordThread,
  discordToken,
} from "./support/discord-messenger.ts";

const credentials = { appToken: "", botToken: discordToken };
const author = "400000000000000001";
const fixtures: ReturnType<typeof discordMessengerFixture>[] = [];
const runs: { controller: AbortController; done: Promise<void> }[] = [];

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Discord fixture deadline");
    await delay(5);
  }
}

function fixture(options?: { closeOnIdentify?: number }) {
  const value = discordMessengerFixture(options);
  fixtures.push(value);

  return value;
}

function run(f: ReturnType<typeof fixture>, onEvent: (event: MessengerEvent) => Promise<void>) {
  const controller = new AbortController();
  const statuses: string[] = [];

  const done = discordAdapter.run(
    {
      accountId: "account",
      credentials,
      botUserId: discordBot,
      transport: f.transport,
      onEvent,
      onStatus: async (status) => {
        statuses.push(status);
      },
    },
    controller.signal,
  );

  runs.push({ controller, done });

  return statuses;
}

const message = (id: string, fields: typeof Schema.JsonObject.Type = {}) => ({
  id,
  channel_id: discordChannel,
  guild_id: "500000000000000001",
  author: { id: author },
  type: 0,
  content: "hello",
  timestamp: "2026-11-27T10:00:00.000Z",
  mentions: [],
  ...fields,
});

/** Direct messages carry no guild. */
function direct(id: string, channel: string) {
  const { guild_id: _guild, ...rest } = message(id, { channel_id: channel });

  return rest;
}

afterEach(async () => {
  for (const { controller, done } of runs.splice(0)) {
    controller.abort();
    await done.catch(() => {});
  }

  for (const f of fixtures.splice(0)) await f.close();
});

describe("Discord messenger adapter", () => {
  test("validation connects once and explains a missing Message Content intent", async () => {
    const signal = AbortSignal.timeout(3000);

    expect(await discordAdapter.validate(credentials, signal, fixture().transport)).toEqual({
      externalId: `discord:${discordBot}`,
      botUserId: discordBot,
    });

    const denied = await discordAdapter
      .validate(credentials, signal, fixture({ closeOnIdentify: 4014 }).transport)
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(denied).toMatchObject({ kind: "configuration", code: "message_content_intent" });
  });

  test("threads map to their parent channel and a failed ingest is replayed by resuming", async () => {
    const f = fixture();
    const events: MessengerEvent[] = [];
    let failOnce = true;

    const statuses = run(f, async (event) => {
      if (event.messageId === "600000000000000002" && failOnce) {
        failOnce = false;

        throw new Error("lease lost");
      }

      events.push(event);
    });

    await until(() => statuses.includes("connected"));
    f.dispatch("MESSAGE_CREATE", message("600000000000000001", { mentions: [{ id: discordBot }] }));
    f.dispatch("MESSAGE_CREATE", message("600000000000000002", { channel_id: discordThread, content: "in thread" }));
    f.dispatch("MESSAGE_CREATE", message("600000000000000003", { author: { id: discordBot, bot: true } }));
    f.dispatch(
      "MESSAGE_CREATE",
      message("600000000000000004", {
        type: 19,
        message_reference: { message_id: "700000000000000001" },
        referenced_message: { author: { id: discordBot } },
      }),
    );
    f.dispatch("MESSAGE_CREATE", direct("600000000000000005", "800000000000000001"));
    await until(() => events.length === 4);

    // The failing thread message was not acknowledged; the resumed session replayed it in order.
    expect(f.resumes).toEqual([{ session_id: "session-1", seq: 1 }]);
    expect(f.identifies()).toBe(1);
    expect(events.map((event) => event.messageId)).toEqual([
      "600000000000000001",
      "600000000000000002",
      "600000000000000004",
      "600000000000000005",
    ]);
    expect(events[0]).toMatchObject({ channelId: discordChannel, threadId: "", mention: true, direct: false });
    expect(events[1]).toMatchObject({ channelId: discordChannel, threadId: `thread:${discordThread}` });
    expect(events[2]).toMatchObject({ mention: true, replyTo: "700000000000000001" });
    expect(events[3]).toMatchObject({ channelId: "800000000000000001", direct: true, mention: false });
  });

  test("replies reference the triggering message, post into threads and split with nonces", async () => {
    const f = fixture();
    const signal = AbortSignal.timeout(3000);
    const base = { id: "outbound-1", accountId: "account", channelId: discordChannel, text: "Done <@123>" };

    expect(
      await discordAdapter.send(credentials, { ...base, threadId: "600000000000000001" }, signal, f.transport),
    ).toEqual({
      channelId: discordChannel,
      messageId: expect.stringMatching(/^\d+$/),
    });
    expect(f.sent[0]).toMatchObject({
      channel: discordChannel,
      body: {
        content: "Done <@123>",
        enforce_nonce: true,
        allowed_mentions: { parse: ["users"] },
        message_reference: { message_id: "600000000000000001" },
      },
    });

    await discordAdapter.send(
      credentials,
      {
        ...base,
        id: "outbound-2",
        threadId: `thread:${discordThread}`,
        text: `${"a".repeat(1800)}\n${"b".repeat(1800)}`,
      },
      signal,
      f.transport,
    );

    expect(f.sent.slice(1).map((sent) => sent.channel)).toEqual([discordThread, discordThread]);
    expect(f.sent[1]!.body["message_reference"]).toBeUndefined();
    expect(new Set(f.sent.map((sent) => sent.body["nonce"])).size).toBe(3);
  });
});

describe("Discord reply files", () => {
  const file = (name: string, bytes: number) => ({ name, mimeType: "application/pdf", data: new Uint8Array(bytes) });

  test("files join the last text part and overflow into further messages within the upload limit", async () => {
    const f = fixture();
    const big = 6 * 1024 ** 2;

    await discordAdapter.send(
      credentials,
      {
        id: "outbound-files",
        accountId: "account",
        channelId: discordChannel,
        threadId: "600000000000000001",
        text: "Here are the reports.",
        files: [file("a.pdf", big), file("b.pdf", big), file("c.pdf", 10)],
      },
      AbortSignal.timeout(3000),
      f.transport,
    );

    // A single message holds at most 10 MB, so the second large file starts a message without text.
    expect(f.sent.map((sent) => sent.body["files"])).toEqual([
      ["files[0]=a.pdf"],
      ["files[0]=b.pdf", "files[1]=c.pdf"],
    ]);
    expect(f.sent[0]!.body).toMatchObject({
      content: "Here are the reports.",
      attachments: [{ id: 0, filename: "a.pdf" }],
      message_reference: { message_id: "600000000000000001" },
    });
    expect(f.sent[1]!.body["content"]).toBeUndefined();
    expect(f.sent[1]!.body["message_reference"]).toBeUndefined();
  });
});
