import { expect, test } from "bun:test";
import { migrate, migrations } from "@canopy/db";
import { dockerAvailable, startPostgres } from "@canopy/db/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { activeChannelTurn } from "../../apps/gateway/src/messengers/conversation-access.ts";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";

test.skipIf(!dockerAvailable)(
  "upgrading a Slack subscription keeps verified pending work and starts with an empty channel projection",
  async () => {
    const db = await startPostgres();
    const runtime = ManagedRuntime.make(db.layer);
    const messenger = ManagedRuntime.make(MessengerStore.layer(Buffer.alloc(32)).pipe(Layer.provideMerge(db.layer)));

    const run = <A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
      messenger.runPromise(MessengerStore.use(use));

    const owner = Bun.randomUUIDv7();
    const bot = Bun.randomUUIDv7();
    const account = Bun.randomUUIDv7();
    const route = Bun.randomUUIDv7();
    const worker = Bun.randomUUIDv7();
    const main = Bun.randomUUIDv7();
    const other = Bun.randomUUIDv7();
    const dm = Bun.randomUUIDv7();

    const work = [
      { turn: Bun.randomUUIDv7(), conversation: main, status: "queued", author: "UALLOWED", message: "100.1" },
      { turn: Bun.randomUUIDv7(), conversation: main, status: "running", author: "UALLOWED", message: "100.2" },
      { turn: Bun.randomUUIDv7(), conversation: main, status: "completed", author: "UALLOWED", message: "100.3" },
      { turn: Bun.randomUUIDv7(), conversation: other, status: "completed", author: "UREMOVED", message: "100.4" },
      { turn: Bun.randomUUIDv7(), conversation: main, status: "queued", author: "UALLOWED", message: "100.5" },
      { turn: Bun.randomUUIDv7(), conversation: dm, status: "queued", author: "UALLOWED", message: "100.6" },
      { turn: Bun.randomUUIDv7(), conversation: main, status: "running", author: "UALLOWED", message: "100.8" },
    ];

    const [queued, running, reply, revoked, unacknowledged, direct, claimed] = work;

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: Effect.map(migrations, (all) => all.filter(([id]) => id <= 219)),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO users(id,email,display_name,role) VALUES (${owner},'slack-upgrade@example.test','Owner','user')`;
            yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES (${worker},${owner},'Worker','hash')`;
            yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
        VALUES (${bot},${owner},'slack-rollout','{}','codex','native')`;
            yield* sql`INSERT INTO messenger_accounts(id,owner_user_id,name,external_id,credentials)
        VALUES (${account},${owner},'Slack','TLEGACY',''::bytea)`;
            yield* sql`INSERT INTO bot_channel_routes(id,owner_user_id,bot_id,account_id,channel_ids,user_ids,mentions,observe,direct_messages,delivery)
        VALUES (${route},${owner},${bot},${account},'{COLD,COTHER}','{UALLOWED}',false,true,true,'reply')`;
            yield* sql`INSERT INTO bot_channel_conversations(id,route_id,channel_id,thread_id,open_until) VALUES
        (${main},${route},'COLD','100.0',now()),(${other},${route},'COTHER','101.0',now()),
        (${dm},${route},'DPRIVATE','',now())`;

            for (const item of work) {
              const input = Bun.randomUUIDv7();
              yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,conversation_id)
          VALUES (${item.turn},${bot},${`messenger:${input}`},'Old message',${item.status},${item.conversation})`;
              yield* sql`INSERT INTO bot_channel_inputs(id,conversation_id,turn_id,text,status)
          VALUES (${input},${item.conversation},${item.turn},'Old message','applied')`;
              yield* sql`INSERT INTO bot_channel_messages(conversation_id,message_id,source_message_id,author_id,text,provider_timestamp,received_at,state,input_id)
          VALUES (${item.conversation},${`${item.message}:0`},${item.message},${item.author},'Old message',${item.message},now(),'consumed',${input})`;
            }

            for (const item of [running!, unacknowledged!]) {
              const status = item === running ? "completed" : "pending";
              yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,status,expires_at)
          VALUES (${item.turn},${worker},'runBotTurn',''::bytea,${status},now()+interval '1 day')`;
              yield* sql`INSERT INTO bot_harness_turns(turn_id,bot_id,worker_id,command_id)
          VALUES (${item.turn},${bot},${worker},${item.turn})`;
            }

            yield* sql`INSERT INTO messenger_outbound(id,account_id,conversation_id,turn_id,channel_id,thread_id,text) VALUES
        (${reply!.turn},${account},${main},${reply!.turn},'COLD','100.0','Pending legacy reply'),
        (${revoked!.turn},${account},${other},${revoked!.turn},'COTHER','101.0','Reply from withdrawn input')`;
            yield* sql`INSERT INTO bot_channel_messages(conversation_id,message_id,source_message_id,author_id,text,provider_timestamp,received_at)
        VALUES (${main},'100.7:0','100.7','UALLOWED','Still buffered','100.7',now())`;
          }),
        ),
      );

      expect(await runtime.runPromise(migrate)).toEqual([[220, "slack_channel_context"]]);
      expect(await run((s) => s.routes(owner))).toMatchObject([
        {
          id: route,
          channelContext: true,
          channelIds: ["COLD", "COTHER"],
          mentions: false,
          observe: true,
          directMessages: true,
          delivery: "reply",
        },
      ]);

      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            expect(yield* sql`SELECT channel_id FROM slack_channel_contexts ORDER BY channel_id`).toEqual([
              { channel_id: "COLD" },
              { channel_id: "COTHER" },
            ]);
            expect(yield* sql`SELECT text,deleted,state FROM bot_channel_messages WHERE message_id='100.7:0'`).toEqual([
              { text: "Still buffered", deleted: false, state: "buffered" },
            ]);

            for (const item of [queued!, running!, reply!, direct!, claimed!]) {
              expect(yield* activeChannelTurn(sql, item.turn)).toBe(true);
            }

            for (const item of [revoked!, unacknowledged!]) {
              expect(yield* activeChannelTurn(sql, item.turn)).toBe(false);
            }
          }),
        ),
      );

      const now = new Date();
      const lease = (await run((s) => s.claimAccount(owner, account, "upgrade", now)))!;
      const outgoing = await run((s) => s.outbound(owner, lease, now));
      expect(outgoing.map((row) => row.id).sort()).toEqual([reply!.turn, revoked!.turn].sort());
      const captured: { text: string; channelId: string; threadId: string }[] = [];

      for (const row of outgoing) {
        const delivery = await run((s) =>
          s.sendClaimed(owner, lease, row.id, now, async () => {
            captured.push({ text: row.text, channelId: row.channelId, threadId: row.threadId });

            return { sent: true, channelId: row.channelId, messageId: "200.1" };
          }),
        );

        if (delivery)
          await run((s) =>
            Effect.promise(() => delivery.completion).pipe(
              Effect.flatMap((result) => s.settleOutbound(owner, lease, row.id, result, now)),
            ),
          );
      }

      expect(captured).toEqual([{ text: "Pending legacy reply", channelId: "COLD", threadId: "100.0" }]);
      expect(
        await runtime.runPromise(
          SqlClient.SqlClient.use((sql) => sql`SELECT text FROM slack_channel_context_messages`),
        ),
      ).toEqual([]);
      expect(
        await run((s) =>
          s.ingest(
            owner,
            {
              id: "delete-queued-source",
              accountId: account,
              channelId: "COLD",
              threadId: "100.0",
              messageId: queued!.message,
              authorId: "UALLOWED",
              text: "",
              timestamp: "300.1",
              mention: false,
              direct: false,
              kind: "delete",
            },
            lease,
            now,
          ),
        ),
      ).toEqual(["message_deleted"]);
      expect(await runtime.runPromise(SqlClient.SqlClient.use((sql) => activeChannelTurn(sql, queued!.turn)))).toBe(
        false,
      );
    } finally {
      await messenger.dispose();
      await runtime.dispose();
      await db.stop();
    }
  },
  30_000,
);
