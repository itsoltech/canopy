import { afterEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerWebSocket } from "bun";
import {
  SlackMessenger,
  SlackMessengerError,
  slackMessengerAppManifest,
  validateSlackAccount,
  type SlackEvent,
  type SlackTransport,
} from "../../apps/gateway/src/messengers/slack.ts";

const credentials = { appToken: "xapp-fixture", botToken: "xoxb-fixture" };
const fixtures: { close: () => Promise<void> }[] = [];

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Slack fixture deadline");
    await delay(5);
  }
}

function fixture() {
  const sockets = new Set<ServerWebSocket<{ id: number }>>();
  const acknowledgments: string[] = [];
  const logs: string[] = [];
  const requests: { method: string; fields: URLSearchParams; authorization: string | null }[] = [];
  const controller = new AbortController();
  let connectionCount = 0;
  let appId = "A1";
  let hello = true;
  let run = Promise.resolve();

  let reply = (method: string): Response => {
    if (method === "auth.test") return Response.json({ ok: true, bot_id: "B1", user_id: "UBOT", team_id: "T1" });

    if (method === "bots.info") return Response.json({ ok: true, bot: { app_id: "A1" } });

    if (method === "apps.connections.open")
      return Response.json({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=private-fixture" });

    return Response.json({ ok: true, ts: "10.000001", channel: "C1" });
  };

  const server = Bun.serve<{ id: number }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, instance) {
      const path = new URL(request.url).pathname;

      if (path === "/socket") {
        if (instance.upgrade(request, { data: { id: ++connectionCount } })) return;

        return new Response("Upgrade required", { status: 400 });
      }

      const method = path.slice("/api/".length);
      requests.push({
        method,
        fields: new URLSearchParams(await request.text()),
        authorization: request.headers.get("authorization"),
      });

      return reply(method);
    },
    websocket: {
      open(socket) {
        sockets.add(socket);

        if (hello) socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: appId } }));
      },
      message(_socket, message) {
        const ack = JSON.parse(message.toString());
        acknowledgments.push(ack.envelope_id);
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });

  const transport: SlackTransport = {
    apiBaseUrl: new URL("api/", server.url).href,
    connect: (url) => {
      expect(url.startsWith("wss://wss-primary.slack.com/")).toBe(true);

      return new WebSocket(new URL("socket", server.url).href.replace("http:", "ws:"));
    },
    reconnectDelayMs: 5,
  };

  const result = {
    transport,
    controller,
    sockets,
    acknowledgments,
    logs,
    requests,
    get connectionCount() {
      return connectionCount;
    },
    set appId(value: string) {
      appId = value;
    },
    set hello(value: boolean) {
      hello = value;
    },
    set reply(value: typeof reply) {
      reply = value;
    },
    start(
      onEvent: (event: SlackEvent) => Promise<void>,
      onStatus?: (status: "connecting" | "connected" | "retrying") => Promise<void>,
    ) {
      const adapter = new SlackMessenger({
        accountId: "account-1",
        credentials,
        botUserId: "UBOT",
        onEvent,
        transport,
        log: (message) => logs.push(message),
        ...(onStatus && { onStatus }),
      });

      run = adapter.run(controller.signal);

      return { adapter, run };
    },
    send(event: ReturnType<typeof envelope> | { type: string; reason: string }) {
      for (const socket of sockets) socket.send(JSON.stringify(event));
    },
    async close() {
      controller.abort();
      await run.catch(() => {});

      for (const socket of sockets) socket.terminate();
      await server.stop(true);
    },
  };

  fixtures.push(result);

  return result;
}

interface EventOverrides {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  thread_ts?: string;
  files?: readonly ({ id: string; url_private?: string } | null)[];
  message?: object;
  previous_message?: object;
  deleted_ts?: string;
}

function envelope(id: string, event: EventOverrides = {}) {
  return {
    type: "events_api",
    envelope_id: `envelope-${id}`,
    payload: {
      type: "event_callback",
      event_id: id,
      team_id: "T1",
      api_app_id: "A1",
      event: {
        type: "message",
        user: "U1",
        text: "hello <@UBOT> and <@U2>",
        channel: "C1",
        ts: "1.000001",
        event_ts: "2.000001",
        ...event,
      },
    },
  };
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) await item.close();
});

describe("Slack messenger provider transport", () => {
  test("accepts a rotated bot token without confusing it with a user token", async () => {
    const f = fixture();
    const botToken = "xoxe.xoxb-fixture";
    expect(await validateSlackAccount({ ...credentials, botToken }, undefined, f.transport)).toMatchObject({
      externalId: "T1:B1",
      appId: "A1",
    });
    expect(f.requests[0]?.authorization).toBe(`Bearer ${botToken}`);
    await expect(
      validateSlackAccount({ ...credentials, botToken: "xoxe.xoxp-fixture" }, undefined, f.transport),
    ).rejects.toMatchObject({ kind: "configuration", code: "invalid_token_type" });
  });

  test("verifies bot/workspace identity and the actual Socket Mode app pairing", async () => {
    const f = fixture();
    expect(await validateSlackAccount(credentials, undefined, f.transport)).toEqual({
      externalId: "T1:B1",
      botUserId: "UBOT",
      teamId: "T1",
      appId: "A1",
    });
    expect(f.requests.map((request) => request.method)).toEqual(["auth.test", "bots.info", "apps.connections.open"]);
    expect(f.requests[0]?.authorization).toBe("Bearer xoxb-fixture");
    expect(f.requests[2]?.authorization).toBe("Bearer xapp-fixture");
    f.appId = "AOTHER";
    await expect(validateSlackAccount(credentials, undefined, f.transport)).rejects.toMatchObject({
      kind: "configuration",
      code: "app_token_mismatch",
    });
  });

  test("ACK waits for durable ingest; redelivery is delivered to the store again and ACKed", async () => {
    const f = fixture();
    const events: SlackEvent[] = [];
    let commit: (() => void) | undefined;

    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });

    f.start(async (event) => {
      events.push(event);
      await committed;
    });
    await until(() => f.sockets.size > 0);
    f.send(envelope("E1"));
    await until(() => events.length === 1);
    expect(f.acknowledgments).toEqual([]);
    commit?.();
    await until(() => f.acknowledgments.length === 1);
    f.send(envelope("E1"));
    await until(() => f.acknowledgments.length === 2);
    expect(events.map((event) => event.id)).toEqual(["E1", "E1"]);
    expect(events[0]).toEqual({
      id: "E1",
      accountId: "account-1",
      channelId: "C1",
      threadId: "",
      messageId: "1.000001",
      authorId: "U1",
      text: "hello <@UBOT> and <@U2>",
      timestamp: "2.000001",
      mention: true,
      direct: false,
      kind: "message",
    });
  });

  test("failed ingest remains unacked and reconnects with a fresh URL", async () => {
    const f = fixture();
    let attempts = 0;
    f.start(async () => {
      if (++attempts === 1) throw new Error("fixture durable commit failure");
    });
    await until(() => f.sockets.size > 0);
    f.send(envelope("EvFAILED"));
    await until(() => f.connectionCount >= 2 && f.sockets.size > 0);
    expect(f.acknowledgments).toEqual([]);
    expect(f.logs).toContain(
      "stage=ingest outcome=failed event_type=message event_id=EvFAILED channel=C1 message_ts=1.000001",
    );
    expect(f.logs).toContain("connection=disconnected reason=socket_ingest_failed");
    expect(f.logs.join("\n")).not.toContain("fixture durable commit failure");
    f.send(envelope("EvFAILED"));
    await until(() => f.acknowledgments.length === 1);
    expect(f.requests.filter((request) => request.method === "apps.connections.open")).toHaveLength(2);
  });

  test("normalizes edits, deletes, user subtypes, and direct replies while suppressing bot loops", async () => {
    const f = fixture();
    const events: SlackEvent[] = [];
    f.start(async (event) => {
      events.push(event);
    });
    await until(() => f.sockets.size > 0);
    f.send(envelope("self", { user: "UBOT" }));
    f.send(envelope("EvIGNORED", { user: "UBOT", channel: "xoxb-fixture-log-test", thread_ts: "arbitrary text" }));
    f.send(envelope("bot", { user: "UOTHERBOT", bot_id: "BOTHER" }));
    f.send(
      envelope("file", {
        subtype: "file_share",
        text: "user fragment",
        files: [
          { id: "FREPORT", url_private: "https://files.slack.com/fixture-private" },
          { id: "FREPORT" },
          { id: "https://invalid.example/file" },
          null,
        ],
      }),
    );
    f.send(envelope("broadcast", { subtype: "thread_broadcast", thread_ts: "0.000001" }));
    f.send(
      envelope("edit", {
        subtype: "message_changed",
        message: { user: "U1", text: "edited", ts: "1.000001", thread_ts: "0.000001" },
      }),
    );
    f.send(
      envelope("delete", {
        subtype: "message_deleted",
        deleted_ts: "1.000001",
        previous_message: { user: "U1", ts: "1.000001", text: "before", thread_ts: "0.000001" },
      }),
    );
    f.send(envelope("direct", { channel: "D1", text: "hello", thread_ts: "0.000001" }));
    f.send(envelope("im", { channel_type: "im", text: "hello" }));
    await until(() => f.acknowledgments.length === 9);
    expect(events.map((event) => event.id)).toEqual(["file", "broadcast", "edit", "delete", "direct", "im"]);
    expect(f.logs).toContain(
      "stage=ignored reason=app_or_bot_message event_type=message event_id=EvIGNORED message_ts=1.000001",
    );
    expect(f.logs.join("\n")).not.toContain("xoxb-fixture-log-test");
    expect(f.logs.join("\n")).not.toContain("arbitrary text");
    expect(events.find((event) => event.id === "file")).toMatchObject({
      text: "user fragment",
      fileIds: ["FREPORT"],
    });
    expect(JSON.stringify(events)).not.toContain("fixture-private");
    expect(events.find((event) => event.id === "edit")).toMatchObject({
      kind: "edit",
      text: "edited",
      threadId: "0.000001",
      messageId: "1.000001",
    });
    expect(events.find((event) => event.id === "delete")).toMatchObject({
      kind: "delete",
      threadId: "0.000001",
      messageId: "1.000001",
    });
    expect(events.find((event) => event.id === "direct")).toMatchObject({
      direct: true,
      mention: false,
      threadId: "0.000001",
    });
    expect(events.find((event) => event.id === "im")?.direct).toBe(true);
  });

  test("server refresh reconnects, abort closes sockets, and status failures stop the lease holder", async () => {
    const f = fixture();
    const states: string[] = [];

    const { run } = f.start(
      async () => {},
      async (status) => {
        states.push(status);
      },
    );

    await until(() => states.includes("connected"));
    f.send({ type: "disconnect", reason: "refresh_requested" });
    await until(() => states.filter((state) => state === "connected").length === 2);
    expect(states).toEqual(["connecting", "connected", "retrying", "connecting", "connected"]);
    f.controller.abort();
    await run;
    await until(() => f.sockets.size === 0);
    const failed = fixture();

    const stopped = failed.start(
      async () => {},
      async (status) => {
        if (status === "connected") throw new Error("lease lost");
      },
    );

    await expect(stopped.run).rejects.toMatchObject({ kind: "configuration", code: "lifecycle_callback_failed" });
  });

  test("abort interrupts an incomplete Socket Mode hello handshake", async () => {
    const f = fixture();
    f.hello = false;
    const { run } = f.start(async () => {});
    await until(() => f.sockets.size > 0);
    f.controller.abort();
    await run;
    await until(() => f.sockets.size === 0);
  });

  test("connection retry observes Retry-After and abort cancels that backoff", async () => {
    const f = fixture();
    const states: string[] = [];
    const scheduled = Promise.withResolvers<number>();
    f.reply = () => new Response("", { status: 429, headers: { "Retry-After": "17" } });
    f.transport.waitForReconnect = (milliseconds, signal) => {
      expect(signal).toBe(f.controller.signal);
      scheduled.resolve(milliseconds);

      return delay(milliseconds, undefined, { signal });
    };

    const { run } = f.start(
      async () => {},
      async (status) => {
        states.push(status);
      },
    );

    expect(await scheduled.promise).toBe(17_000);
    f.controller.abort();
    await run;
    expect(f.requests.map((request) => request.method)).toEqual(["auth.test"]);
    expect(states).toEqual(["connecting", "retrying"]);
  });

  test("oversized frames never reach ingest and trigger a reconnect", async () => {
    const f = fixture();
    const events: SlackEvent[] = [];
    f.start(async (event) => {
      events.push(event);
    });
    await until(() => f.sockets.size > 0);
    f.send(envelope("large", { text: "a".repeat(1024 * 1024) }));
    await until(() => f.connectionCount >= 2);
    expect(events).toEqual([]);
    expect(f.acknowledgments).toEqual([]);
  });

  test("outbound formats Markdown and individual mentions with the same reply target and no unfurls", async () => {
    const f = fixture();

    const adapter = new SlackMessenger({
      accountId: "account-1",
      credentials,
      botUserId: "UBOT",
      transport: f.transport,
      onEvent: async () => {},
    });

    const message = {
      id: "892c2766-7c2f-4913-a5b7-168df26d7661",
      channelId: "C1",
      threadId: "1.000001",
      text:
        "<@U1> **Bots** & [PR #996](https://example.com/pull/996)\n\n" +
        "1. Open https://example.com/check\n2. Keep `<@U2>` and <!channel> literal",
    };

    expect(await adapter.send(message)).toEqual({ messageId: "10.000001", channelId: "C1" });
    await adapter.send(message);
    const first = f.requests[0]?.fields;
    expect(first?.get("client_msg_id")).toBe(message.id);
    expect(first?.get("client_msg_id")).toBe(f.requests[1]?.fields.get("client_msg_id"));
    expect(first?.get("text")).toBe(
      "@U1 Bots &amp; PR #996\n1. Open https://example.com/check\n2. Keep &lt;@U2&gt; and &lt;!channel&gt; literal",
    );
    expect(JSON.parse(first?.get("blocks") ?? "null")).toEqual([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "user", user_id: "U1" },
              { type: "text", text: " " },
              { type: "text", text: "Bots", style: { bold: true } },
              { type: "text", text: " & " },
              { type: "link", url: "https://example.com/pull/996", text: "PR #996" },
            ],
          },
          {
            type: "rich_text_list",
            style: "ordered",
            indent: 0,
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Open " },
                  { type: "link", url: "https://example.com/check", text: "https://example.com/check" },
                ],
              },
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Keep " },
                  { type: "text", text: "<@U2>", style: { code: true } },
                  { type: "text", text: " and <!channel> literal" },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(first?.get("thread_ts")).toBe("1.000001");
    expect(first?.get("parse")).toBe("none");

    for (const field of ["mrkdwn", "link_names", "unfurl_links", "unfurl_media"])
      expect(first?.get(field)).toBe("false");
    await expect(adapter.send({ ...message, text: "a".repeat(40_001) })).rejects.toMatchObject({
      code: "message_size_limit",
    });
    expect(f.requests).toHaveLength(2);
  });

  test("accepts the receipt when Slack echoes a long formatted message", async () => {
    const f = fixture();

    const adapter = new SlackMessenger({
      accountId: "account-1",
      credentials,
      botUserId: "UBOT",
      transport: f.transport,
      onEvent: async () => {},
    });

    f.reply = () => {
      const fields = f.requests.at(-1)?.fields;
      const blocks = fields?.get("blocks") ?? "";
      expect(Buffer.byteLength(blocks)).toBeGreaterThan(256 * 1024);

      return Response.json({
        ok: true,
        ts: "10.000001",
        channel: "C1",
        message: { text: fields?.get("text"), blocks: JSON.parse(blocks) },
      });
    };

    const text = "\\*".repeat(12_000);
    expect(await adapter.send({ id: "long-markdown", channelId: "C1", text })).toEqual({
      messageId: "10.000001",
      channelId: "C1",
    });
    expect(f.requests).toHaveLength(1);
  });

  test("rate limits expose Retry-After and uncertain writes are never retried or logged verbatim", async () => {
    const f = fixture();

    const adapter = new SlackMessenger({
      accountId: "account-1",
      credentials,
      botUserId: "UBOT",
      transport: f.transport,
      onEvent: async () => {},
    });

    const message = { id: "outbound-id", channelId: "C1", text: "hello" };
    f.reply = () => new Response("private-fixture-body", { status: 429, headers: { "Retry-After": "17" } });
    await expect(adapter.send(message)).rejects.toMatchObject({
      kind: "retryable",
      code: "rate_limited",
      retryAfterMs: 17_000,
    });
    expect(f.requests).toHaveLength(1);
    f.reply = () => Response.json({ ok: false, error: "private-token-or-error" });
    await expect(adapter.send(message)).rejects.toMatchObject({
      kind: "unknown_write",
      message: "Slack messenger: provider_error",
    });
    expect(f.requests).toHaveLength(2);
    f.reply = () => new Response("private-token-or-error", { status: 503 });
    await expect(adapter.send(message)).rejects.toMatchObject({ kind: "unknown_write", code: "http_error" });
    expect(f.requests).toHaveLength(3);

    const offline = new SlackMessenger({
      accountId: "a",
      credentials,
      botUserId: "UBOT",
      onEvent: async () => {},
      transport: {
        fetch: async () => {
          throw new Error("xoxb-secret transport url");
        },
      },
    });

    await expect(offline.send(message)).rejects.toMatchObject({
      kind: "unknown_write",
      message: "Slack messenger: transport_error",
    });
  });

  test("aborting an already dispatched post leaves its delivery uncertain", async () => {
    const f = fixture();
    let dispatched = false;

    const adapter = new SlackMessenger({
      accountId: "a",
      credentials,
      botUserId: "UBOT",
      onEvent: async () => {},
      transport: {
        ...f.transport,
        fetch: async (input, init) => {
          dispatched = true;
          await fetch(input, init);
          await delay(10_000, undefined, { signal: init?.signal ?? undefined });

          return Response.json({ ok: true, ts: "1.000001", channel: "C1" });
        },
      },
    });

    const sending = adapter.send({ id: "outbound-id", channelId: "C1", text: "hello" }, f.controller.signal);
    await until(() => dispatched && f.requests.length === 1);
    f.controller.abort();
    await expect(sending).rejects.toMatchObject({ kind: "unknown_write", code: "transport_error" });
    expect(f.requests).toHaveLength(1);
  });

  test("auth and scope errors terminate connection attempts; unsafe socket URLs are rejected", async () => {
    const f = fixture();
    f.reply = () => Response.json({ ok: false, error: "missing_scope", needed: "users:read", provided: "secret" });
    const { run } = f.start(async () => {});
    await expect(run).rejects.toMatchObject({ kind: "configuration", code: "missing_scope" });
    expect(f.requests).toHaveLength(1);

    for (const code of ["token_expired", "token_revoked"]) {
      f.reply = () => Response.json({ ok: false, error: code });
      const expired = f.start(async () => {});
      await expect(expired.run).rejects.toMatchObject({ kind: "configuration", code });
    }

    await expect(
      validateSlackAccount({ ...credentials, botToken: "xoxp-fixture" }, undefined, f.transport),
    ).rejects.toBeInstanceOf(SlackMessengerError);
    const unsafe = fixture();
    unsafe.reply = (method) => {
      if (method === "auth.test") return Response.json({ ok: true, bot_id: "B1", user_id: "UBOT", team_id: "T1" });

      if (method === "bots.info") return Response.json({ ok: true, bot: { app_id: "A1" } });

      return Response.json({ ok: true, url: "ws://127.0.0.1/private-token" });
    };

    await expect(validateSlackAccount(credentials, undefined, unsafe.transport)).rejects.toMatchObject({
      kind: "configuration",
      code: "invalid_socket_url",
    });
    expect(unsafe.connectionCount).toBe(0);
  });

  test("one Slack app manifest configures MCP, Socket Mode and token rotation", () => {
    const manifest = JSON.parse(slackMessengerAppManifest());
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "app_mention",
      "message.im",
      "message.mpim",
      "message.channels",
      "message.groups",
    ]);
    expect(manifest.oauth_config.scopes.bot).toContain("users:read");
    expect(manifest.oauth_config.scopes.bot).toContain("chat:write");
    expect(manifest.settings.is_mcp_enabled).toBe(true);
    expect(manifest.settings.token_rotation_enabled).toBe(true);
    expect(manifest.oauth_config.pkce_enabled).toBe(true);
    expect(manifest.oauth_config.scopes.user).toContain("search:read.public");
    expect(manifest.oauth_config.redirect_urls).toHaveLength(1);
  });
});
