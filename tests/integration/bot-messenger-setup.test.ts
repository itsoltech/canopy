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

    await botStore((s) =>
      s.enqueue(gw.userId, bot.id, "Listen to product and remember my reaction instructions", Bun.randomUUIDv7()),
    );
    const turn = (await botStore((s) => s.claim(gw.userId)))!;
    expect(turn.bot_id).toBe(bot.id);

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
      await expect(call(f.turn, "save_messenger_subscription", args)).rejects.toThrow("private message");
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
