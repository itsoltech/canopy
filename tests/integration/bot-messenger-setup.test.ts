import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { Effect, Match, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { areaTool } from "../../apps/gateway/src/bots/tools/index.ts";
import { context, validate } from "../../apps/gateway/src/bots/tools/shared.ts";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import { slackMessengerAppManifest } from "../../apps/gateway/src/messengers/slack.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const subscription = (accountId: string) => ({
  account_id: accountId,
  channel_ids: ["CPRODUCT"],
  user_ids: ["UOWNER", "UCOLLEAGUE"],
  direct_messages: false,
  mentions: true,
  observe: true,
  delivery: "notify",
  instructions:
    "Record decisions using my granted tools. Ask authors to clarify problems; notify me only when actionable.",
});

describe.skipIf(!dockerAvailable)("private owner messenger subscription tools", () => {
  let gw: TestGateway;
  let server: ReturnType<typeof Bun.serve>;
  const pages: string[] = [];
  let authenticated = false;
  let blocked: Promise<void> | undefined;
  let entered: (() => void) | undefined;

  const messenger = <A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    gw.runtime.runPromise(MessengerStore.use(use));

  const botStore = <A, E>(use: (store: BotStore["Service"]) => Effect.Effect<A, E>) =>
    gw.runtime.runPromise(BotStore.use(use));

  const query = <A extends object>(statement: string, values: readonly string[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(statement, values)));

  beforeAll(async () => {
    gw = await startTestGateway();
    await gw.core.bots.stop();
    await gw.core.messengers.stop();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        authenticated = request.headers.get("authorization") === "Bearer xoxb-fixture";
        const fields = new URLSearchParams(await request.text());
        const cursor = fields.get("cursor") ?? "";
        pages.push(cursor);
        entered?.();
        await blocked;

        if (new URL(request.url).pathname.endsWith("conversations.members"))
          return Response.json({
            ok: true,
            members: cursor ? ["UCOLLEAGUE"] : ["UOWNER"],
            response_metadata: { next_cursor: cursor ? "" : "members-2" },
          });

        if (new URL(request.url).pathname.endsWith("users.list"))
          return Response.json({
            ok: true,
            members: [
              {
                id: "UOWNER",
                name: "owner",
                real_name: "Alex Owner",
                profile: { display_name: "Alex", email: "private@example.test" },
              },
              { id: "UCOLLEAGUE", name: "colleague", real_name: "Alex Colleague", profile: { display_name: "Alex" } },
              { id: "UDELETED", name: "alex-old", deleted: true },
              { id: "UBOT", name: "alex-bot", is_bot: true },
            ],
            response_metadata: { next_cursor: "" },
          });

        return Response.json({
          ok: true,
          channels: cursor
            ? [{ id: "CPRODUCT", name: "product", is_member: true, is_private: true }]
            : [
                { id: "CUNJOINED", name: "product-other", is_member: false, is_private: false },
                { id: "CARCHIVED", name: "product-old", is_member: true, is_private: false, is_archived: true },
              ],
          response_metadata: { next_cursor: cursor ? "" : "page-2" },
        });
      },
    });
  });
  afterAll(async () => {
    server?.stop(true);
    await gw?.close();
  });

  const claimOwnerTurn = async (botId: string, text: string) => {
    await botStore((s) => s.enqueue(gw.userId, botId, text, Bun.randomUUIDv7()));
    const turn = (await botStore((s) => s.claim(gw.userId)))!;
    expect(turn).toMatchObject({ bot_id: botId, conversation_id: null });

    return turn;
  };

  const fixture = async () => {
    const bot = await gw.core.bots.create(
      create(bots.CreateBotRequestSchema, {
        clientRequestId: Bun.randomUUIDv7(),
        configuration: {
          name: `Subscription ${Bun.randomUUIDv7()}`,
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          shape: "round",
          color: "#22aaff",
        },
      }),
    );

    const account = await messenger((s) =>
      s.saveAccount(gw.userId, {
        name: "Product workspace",
        externalId: Bun.randomUUIDv7(),
        appToken: "xapp-fixture",
        botToken: "xoxb-fixture",
      }),
    );

    const turn = await claimOwnerTurn(bot.id, "Listen to product and remember my reaction instructions");

    return { bot, account, turn };
  };

  const call = async (
    turn: BotTurn,
    name: string,
    args: JsonObject = {},
    key = Bun.randomUUIDv7(),
    userId = gw.userId,
  ) => {
    const tool = areaTool.get(name)!;
    validate(tool.spec.parameters, args);
    const stored = await botStore((s) => s.planCall(turn, key, tool.spec, args));

    return tool.execute(
      context(
        gw.core,
        {
          runtime: gw.runtime,
          userId,
          instanceId: "subscription-tools",
          messengerTransport: { apiBaseUrl: new URL("api/", server.url).href },
        },
        turn,
        stored,
      ),
    );
  };

  const finish = (turn: BotTurn) => botStore((s) => s.finish(turn, "completed", ""));

  async function historyFixture() {
    const { bot, account, turn } = await fixture();
    const args = { ...subscription(account.id), channel_ids: ["CPRODUCT", "COPS"], delivery: "reply", observe: false };
    await call(turn, "save_messenger_subscription", args);
    await finish(turn);
    const now = new Date();
    const lease = (await messenger((s) => s.claimAccount(gw.userId, account.id, "history-test", now)))!;

    const dispatch = async (channelId: string, threadId: string, messageId: string, text: string) => {
      const event = {
        id: Bun.randomUUIDv7(),
        accountId: account.id,
        channelId,
        threadId,
        messageId,
        authorId: "UOWNER",
        text,
        timestamp: messageId,
        mention: true,
        direct: false,
      };

      expect(await messenger((s) => s.ingest(gw.userId, event, lease, now))).toEqual(["buffered"]);

      return messenger((s) => s.dispatch(gw.userId, new Date(now.getTime() + 3000)));
    };

    const start = async (channelId: string, threadId: string, text: string) => {
      expect(await dispatch(channelId, threadId, threadId, text)).toEqual([]);
      const active = (await botStore((s) => s.claim(gw.userId)))!;
      expect(active).toMatchObject({ bot_id: bot.id, input: expect.stringContaining(text) });

      return active;
    };

    return { bot, account, args, dispatch, start };
  }

  test("private owner history lists the latest ten Slack outcomes and opens one precise transcript", async () => {
    const f = await historyFixture();
    const first = await f.start("CPRODUCT", "100.1", "Check missing receipts");
    const [steer] = await f.dispatch("CPRODUCT", "100.1", "100.2", "Include yesterday");
    expect(steer?.turnId).toBe(first.id);
    await messenger((s) => s.settleSteer(gw.userId, steer!.id, true, first.id));
    await botStore((s) => s.finish(first, "completed", "Found the missing receipts"));
    const failed = await f.start("COPS", "200.1", "Inspect sync failures");
    await botStore((s) => s.finish(failed, "failed", "The provider session expired", "session_expired", "harness"));

    const older = await query<{ id: string }>(
      `WITH past AS (INSERT INTO bot_turns(id,bot_id,client_request_id,conversation_id,input,status,created_at)
       SELECT gen_random_uuid(),$1::uuid,'past-' || n,$2::uuid,'Past request','completed',now() - n * interval '1 day'
       FROM generate_series(1, 9) n RETURNING id,created_at) SELECT id FROM past ORDER BY created_at DESC`,
      [f.bot.id, first.conversation_id!],
    );

    const owner = await claimOwnerTurn(f.bot.id, "What happened in Slack?");

    try {
      const summary = await call(owner, "read_messenger_history");

      const turns = Schema.decodeUnknownSync(
        Schema.Struct({ turns: Schema.Array(Schema.Struct({ turn_id: Schema.String })) }),
      )(summary).turns;

      expect(turns.map((t) => t.turn_id)).toEqual([failed.id, first.id, ...older.slice(0, 8).map((row) => row.id)]);
      const encoded = JSON.stringify(summary);

      for (const text of [
        "messages",
        "Check missing receipts",
        "Include yesterday",
        "Found the missing receipts",
        "Inspect sync failures",
        "The provider session expired",
      ])
        expect(encoded).not.toContain(text);
      expect(await call(owner, "read_messenger_history", { channel_id: "COPS" })).toMatchObject({
        turns: [
          {
            turn_id: failed.id,
            account: f.account.name,
            channel_id: "COPS",
            thread_id: "200.1",
            status: "failed",
            delivery_status: null,
            error_code: "session_expired",
            error_source: "harness",
            created_at: expect.any(String),
          },
        ],
      });
      expect(await call(owner, "read_messenger_history", { channel_id: "COPS", thread_ts: "100.1" })).toMatchObject({
        turns: [],
      });
      expect(await call(owner, "read_messenger_history", { turn_id: first.id })).toMatchObject({
        turns: [
          {
            turn_id: first.id,
            status: "completed",
            delivery_status: "pending",
            messages: [
              { sender_id: "channel", text: expect.stringContaining("Check missing receipts") },
              { sender_id: "channel", text: expect.stringContaining("Include yesterday") },
              { sender_id: f.bot.id, text: "Found the missing receipts" },
            ],
          },
        ],
      });
      expect(await call(owner, "read_messenger_history", { turn_id: failed.id })).toMatchObject({
        turns: [
          {
            turn_id: failed.id,
            messages: [
              { sender_id: "channel", text: expect.stringContaining("Inspect sync failures") },
              { sender_id: f.bot.id, text: "The provider session expired" },
            ],
          },
        ],
      });
    } finally {
      await finish(owner);
    }
  });

  test("private history excludes other bots and channels removed from the subscription", async () => {
    const f = await historyFixture();
    const external = await f.start("COPS", "300.1", "Private incident report");
    await botStore((s) => s.finish(external, "completed", "Incident received"));
    const other = await fixture();

    try {
      expect(await call(other.turn, "read_messenger_history")).toMatchObject({ turns: [] });
      expect(await call(other.turn, "read_messenger_history", { turn_id: external.id })).toMatchObject({ turns: [] });
    } finally {
      await finish(other.turn);
    }

    const owner = await claimOwnerTurn(f.bot.id, "Which Slack turns can I see?");

    try {
      await expect(
        call(owner, "read_messenger_history", { turn_id: external.id }, undefined, Bun.randomUUIDv7()),
      ).rejects.toThrow("private message");
      expect(await call(owner, "read_messenger_history")).toMatchObject({ turns: [{ turn_id: external.id }] });
      await call(owner, "save_messenger_subscription", { ...f.args, channel_ids: ["CPRODUCT"] });
      expect(await call(owner, "read_messenger_history")).toMatchObject({ turns: [] });
      expect(await call(owner, "read_messenger_history", { turn_id: external.id })).toMatchObject({ turns: [] });
    } finally {
      await finish(owner);
    }
  });

  test("private setup persists instructions, survives reclaimed calls, replaces one own route and stops idempotently", async () => {
    const f = await fixture();

    try {
      const accounts = JSON.stringify(await call(f.turn, "list_messenger_accounts"));
      expect(accounts).toContain(f.account.id);
      expect(accounts).not.toContain("xapp-");
      expect(accounts).not.toContain("xoxb-");
      const args = subscription(f.account.id);
      const key = Bun.randomUUIDv7();
      const first = await call(f.turn, "save_messenger_subscription", args, key);
      await botStore((s) => s.release(f.turn));
      f.turn = (await botStore((s) => s.claim(gw.userId)))!;
      expect(await call(f.turn, "save_messenger_subscription", args, key)).toEqual(first);
      const [route] = await messenger((s) => s.routes(gw.userId, f.bot.id));
      expect(route!.instructions).toBe(args["instructions"]);

      const revised = {
        ...args,
        instructions: "Ask authors first; use any ordinary tools already granted.",
        delivery: "reply",
        observe: false,
      };

      await call(f.turn, "save_messenger_subscription", revised);
      const routes = await messenger((s) => s.routes(gw.userId, f.bot.id));
      expect(routes).toHaveLength(1);
      expect(routes[0]!.id).toBe(route!.id);
      expect(routes[0]!.instructions).toBe(revised.instructions);
      expect(routes[0]!.delivery).toBe("reply");
      expect(await call(f.turn, "save_messenger_subscription", args, key)).toEqual(first);
      expect((await messenger((s) => s.routes(gw.userId, f.bot.id)))[0]!.instructions).toBe(revised.instructions);
      expect(JSON.stringify(await call(f.turn, "list_messenger_subscriptions"))).toContain(revised.instructions);
      const stopKey = Bun.randomUUIDv7();
      const stop = { subscription_id: route!.id };
      expect(await call(f.turn, "stop_messenger_subscription", stop, stopKey)).toEqual({ stopped: true });
      expect(await call(f.turn, "stop_messenger_subscription", stop, stopKey)).toEqual({ stopped: true });
      expect(await messenger((s) => s.routes(gw.userId, f.bot.id))).toEqual([]);
    } finally {
      await finish(f.turn);
    }
  });

  test("channel discovery stays gateway-side, paginates by name, excludes unjoined channels and holds no turn lock over HTTP", async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    blocked = release.promise;
    entered = started.resolve;
    const pending = call(f.turn, "list_messenger_channels", { account_id: f.account.id, name: "#Product" });

    try {
      await started.promise;
      await gw.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(sql`SELECT id FROM bot_turns WHERE id=${f.turn.id}::uuid FOR UPDATE NOWAIT`),
        ),
      );
      release.resolve();
      expect(await pending).toEqual({ channels: [], next_cursor: "page-2" });
      blocked = undefined;
      entered = undefined;
      expect(
        await call(f.turn, "list_messenger_channels", { account_id: f.account.id, name: "#Product", cursor: "page-2" }),
      ).toEqual({
        channels: [{ id: "CPRODUCT", name: "product", private: true }],
        next_cursor: "",
      });
      expect(authenticated).toBe(true);
      expect(pages.slice(-2)).toEqual(["", "page-2"]);
      expect(
        await call(f.turn, "list_messenger_channel_members", { account_id: f.account.id, channel_id: "CPRODUCT" }),
      ).toEqual({ user_ids: ["UOWNER"], next_cursor: "members-2" });
      expect(
        await call(f.turn, "list_messenger_channel_members", {
          account_id: f.account.id,
          channel_id: "CPRODUCT",
          cursor: "members-2",
        }),
      ).toEqual({ user_ids: ["UCOLLEAGUE"], next_cursor: "" });
      const people = await call(f.turn, "list_messenger_users", { account_id: f.account.id, name: "@Alex" });
      expect(people).toEqual({
        users: [
          { id: "UOWNER", username: "owner", name: "Alex Owner", display_name: "Alex" },
          { id: "UCOLLEAGUE", username: "colleague", name: "Alex Colleague", display_name: "Alex" },
        ],
        next_cursor: "",
      });
      expect(JSON.stringify(people)).not.toContain("private@example.test");
      expect(await messenger((s) => s.routes(gw.userId, f.bot.id))).toEqual([]);

      const manifest = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            oauth_config: Schema.Struct({ scopes: Schema.Struct({ bot: Schema.Array(Schema.String) }) }),
          }),
        ),
      )(slackMessengerAppManifest());

      expect(manifest.oauth_config.scopes.bot).toContain("channels:read");
      expect(manifest.oauth_config.scopes.bot).toContain("groups:read");
    } finally {
      release.resolve();
      await pending;
      blocked = undefined;
      entered = undefined;
      await finish(f.turn);
    }
  });

  test("setting writes refuse an owner turn without the stored approval", async () => {
    const f = await fixture();

    try {
      const before = (await gw.api.getSettings({})).user!;

      await expect(
        call(f.turn, "set_canopy_preference", {
          setting_id: "appearance.color_scheme",
          value: "dark",
          expected_version: String(before.version),
        }),
      ).rejects.toThrow("needs your approval");
      expect((await gw.api.getSettings({})).user).toEqual(before);
    } finally {
      await finish(f.turn);
    }
  });

  test("persisted provenance denies forged owner context, background, handoff, bot, exchange and external administration", async () => {
    const f = await fixture();
    const args = subscription(f.account.id);

    try {
      await expect(call(f.turn, "save_messenger_subscription", args, undefined, Bun.randomUUIDv7())).rejects.toThrow(
        "private message",
      );

      for (const change of [
        "hops=1",
        "handoff_configuration='{}'::jsonb",
        "reply_to_bot_id=bot_id",
        "exchange_id=gen_random_uuid()",
        "remote_recipient_ref='remote-bot'",
      ]) {
        await query(`UPDATE bot_turns SET ${change} WHERE id=$1`, [f.turn.id]);
        await expect(call(f.turn, "save_messenger_subscription", args)).rejects.toThrow("private message");
        await query(
          "UPDATE bot_turns SET hops=0,handoff_configuration=NULL,reply_to_bot_id=NULL,exchange_id=NULL,remote_recipient_ref=NULL WHERE id=$1",
          [f.turn.id],
        );
      }

      await query("UPDATE bot_turns SET hops=1 WHERE id=$1", [f.turn.id]);
      await expect(call(f.turn, "search_canopy_preferences", { query: "color" })).rejects.toThrow(
        "private owner message",
      );
      await query("UPDATE bot_turns SET hops=0 WHERE id=$1", [f.turn.id]);

      await query("UPDATE bot_messages SET sender_id='another-bot' WHERE turn_id=$1 AND message_key='input'", [
        f.turn.id,
      ]);
      await expect(call(f.turn, "save_messenger_subscription", args)).rejects.toThrow("private message");
      await query("UPDATE bot_messages SET sender_id='user',kind='event' WHERE turn_id=$1 AND message_key='input'", [
        f.turn.id,
      ]);
      await expect(call(f.turn, "save_messenger_subscription", args)).rejects.toThrow("private message");
      await query("UPDATE bot_messages SET kind='message' WHERE turn_id=$1 AND message_key='input'", [f.turn.id]);
      await botStore((s) =>
        s.createRoutine(
          gw.userId,
          f.turn,
          Bun.randomUUIDv7(),
          {
            title: "Background",
            instructions: "Observe",
            cron: "0 * * * *",
            timezone: "UTC",
          },
          new Date(),
        ),
      );
      const routines = await botStore((s) => s.routines(gw.userId, f.bot.id));
      await query("UPDATE bot_turns SET routine_id=$1 WHERE id=$2", [routines[0]!.id, f.turn.id]);
      await expect(call(f.turn, "read_messenger_history")).rejects.toThrow("private message");
      await expect(call(f.turn, "save_messenger_subscription", args)).rejects.toThrow("private message");
      await expect(call(f.turn, "get_canopy_preference", { setting_id: "appearance.color_scheme" })).rejects.toThrow(
        "private owner message",
      );
      await query("UPDATE bot_turns SET routine_id=NULL WHERE id=$1", [f.turn.id]);

      const route = await messenger((s) =>
        s.saveRoute(gw.userId, {
          botId: f.bot.id,
          accountId: f.account.id,
          channelIds: ["CPRODUCT"],
          userIds: ["UOWNER"],
          directMessages: false,
          mentions: true,
          observe: false,
          delivery: "reply",
          instructions: "Original instructions",
        }),
      );

      const conversation = (
        await query<{ id: string }>(
          "INSERT INTO bot_channel_conversations(id,route_id,channel_id,thread_id,open_until) VALUES(gen_random_uuid(),$1,'CPRODUCT','100.1',now()) RETURNING id",
          [route.id],
        )
      )[0]!;

      await query("UPDATE bot_turns SET conversation_id=$1 WHERE id=$2", [conversation.id, f.turn.id]);

      for (const name of [
        "read_messenger_history",
        "list_messenger_accounts",
        "list_messenger_subscriptions",
        "list_messenger_channels",
        "list_messenger_channel_members",
        "list_messenger_users",
        "save_messenger_subscription",
        "stop_messenger_subscription",
      ]) {
        const input = Match.value(name).pipe(
          Match.when("save_messenger_subscription", () => args),
          Match.when("stop_messenger_subscription", () => ({ subscription_id: route.id })),
          Match.when("list_messenger_channels", () => ({ account_id: f.account.id })),
          Match.when("list_messenger_channel_members", () => ({ account_id: f.account.id, channel_id: "CPRODUCT" })),
          Match.when("list_messenger_users", () => ({ account_id: f.account.id })),
          Match.orElse(() => ({})),
        );

        await expect(call({ ...f.turn, conversation_id: null }, name, input)).rejects.toThrow("private message");
      }

      const forgedPrivateTurn = { ...f.turn, conversation_id: null };
      const before = (await gw.api.getSettings({})).user!;

      await expect(call(forgedPrivateTurn, "search_canopy_preferences", { query: "color" })).rejects.toThrow(
        "private owner message",
      );
      await expect(
        call(forgedPrivateTurn, "set_canopy_preference", {
          setting_id: "appearance.color_scheme",
          value: "dark",
          expected_version: String(before.version),
        }),
      ).rejects.toThrow("private owner message");
      expect((await gw.api.getSettings({})).user).toEqual(before);
      expect((await messenger((s) => s.routes(gw.userId, f.bot.id)))[0]!.instructions).toBe("Original instructions");
    } finally {
      await finish(f.turn);
    }
  });

  test("own-route scope and the existing author allowlist and responder overlap rules cannot be bypassed", async () => {
    const f = await fixture();

    try {
      const args = subscription(f.account.id);
      await expect(call(f.turn, "save_messenger_subscription", { ...args, user_ids: [] })).rejects.toThrow(
        "routing settings",
      );
      await expect(call(f.turn, "save_messenger_subscription", { ...args, user_ids: ["everyone"] })).rejects.toThrow(
        "routing settings",
      );
      await expect(
        call(f.turn, "save_messenger_subscription", { ...args, subscription_id: Bun.randomUUIDv7() }),
      ).rejects.toThrow("not found");
      const otherId = Bun.randomUUIDv7();
      await query(
        "INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) SELECT $1::uuid,owner_user_id,$1,configuration,provider,provider_instance FROM bots WHERE id=$2",
        [otherId, f.bot.id],
      );

      const otherRoute = await messenger((s) =>
        s.saveRoute(gw.userId, {
          botId: otherId,
          accountId: f.account.id,
          channelIds: ["CPRODUCT"],
          userIds: ["UOWNER"],
          directMessages: false,
          mentions: true,
          observe: false,
          delivery: "reply",
          instructions: "Other bot",
        }),
      );

      expect(await call(f.turn, "list_messenger_subscriptions")).toEqual([]);
      await expect(call(f.turn, "stop_messenger_subscription", { subscription_id: otherRoute.id })).rejects.toThrow(
        "not found",
      );
      await expect(
        call(f.turn, "save_messenger_subscription", { ...args, subscription_id: otherRoute.id }),
      ).rejects.toThrow("not found");
      await expect(call(f.turn, "save_messenger_subscription", { ...args, delivery: "reply" })).rejects.toThrow(
        "Another bot already replies",
      );
      await call(f.turn, "save_messenger_subscription", args);
      expect(await messenger((s) => s.routes(gw.userId, f.bot.id))).toHaveLength(1);
    } finally {
      await finish(f.turn);
    }
  });
});
