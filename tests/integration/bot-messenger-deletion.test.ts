import { expect, test } from "bun:test";
import { Provider, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MessengerAccountSession } from "../../apps/gateway/src/messengers/account-session.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { slackMessengerFixture } from "./support/slack-messenger.ts";

function addBot(gw: TestGateway, name: string) {
  return gw.api.createBot({
    clientRequestId: crypto.randomUUID(),
    configuration: {
      name,
      shape: "round",
      color: "#22aaff",
      provider: Provider.CODEX,
      providerInstance: "native",
      model: "gpt-6.1-sol",
      workerId: gw.workerId,
    },
  });
}

function deletionRecords(gw: TestGateway, botId: string, routeId: string) {
  const query = <Row extends object>(statement: string, id: string) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Row>(statement, [id])));

  return {
    outbound: () =>
      query<{ text: string; status: string; lease_token: string | null }>(
        `SELECT o.text, o.status, o.lease_token FROM messenger_outbound o
         JOIN bot_turns t ON t.id=o.turn_id WHERE t.bot_id=$1::uuid ORDER BY o.text`,
        botId,
      ),
    messages: () =>
      query<{ id: string; text: string; state: string; deleted: boolean }>(
        `SELECT m.id, m.text, m.state, m.deleted FROM bot_channel_messages m
         JOIN bot_channel_conversations c ON c.id=m.conversation_id WHERE c.route_id=$1::uuid ORDER BY m.id`,
        routeId,
      ),
    inputs: () =>
      query<{ id: string; text: string; status: string }>(
        `SELECT i.id, i.text, i.status FROM bot_channel_inputs i
         JOIN bot_channel_conversations c ON c.id=i.conversation_id WHERE c.route_id=$1::uuid ORDER BY i.id`,
        routeId,
      ),
    history: () => query("SELECT id, text FROM bot_messages WHERE bot_id=$1::uuid ORDER BY seq", botId),
    turns: () =>
      query<{ id: string; status: string }>(
        "SELECT id, status FROM bot_turns WHERE bot_id=$1::uuid ORDER BY created_at, id",
        botId,
      ),
    conversations: () =>
      query(
        `SELECT c.id, r.deleted_at IS NOT NULL AS retired, c.open_until <= now() AS closed,
           c.first_received_at, c.last_received_at FROM bot_channel_conversations c
         JOIN bot_channel_routes r ON r.id=c.route_id WHERE r.id=$1::uuid`,
        routeId,
      ),
  };
}

async function exerciseDeletion(
  gw: TestGateway,
  slack: ReturnType<typeof slackMessengerFixture>,
  session: MessengerAccountSession,
  route: ui.BotMessengerRoute,
  survivor: ui.BotMessengerRoute,
  holdResponse: () => void,
  releaseResponse: () => void,
) {
  const messenger = gw.core.messengers;
  const records = deletionRecords(gw, route.botId, route.id);

  async function receive(id: string, text: string, timestamp: string, threadId = "100.1") {
    slack.emit(id, text, timestamp, threadId);
    // Slack receives the ACK after the gateway commits the ingest transaction.
    expect(await eventually(async () => slack.acknowledged.has(id), Boolean)).toBe(true);
  }

  const dispatch = () => messenger.run((s) => s.dispatch(gw.userId, new Date(Date.now() + 3000)));

  async function claim(botId: string, input: string) {
    expect(await dispatch()).toEqual([]);
    const turn = await gw.core.bots.run((s) => s.claim(gw.userId));
    expect(turn).toMatchObject({ bot_id: botId, status: "running", input: expect.stringContaining(input) });

    return turn!;
  }

  async function reply(botId: string, input: string, text: string) {
    const turn = await claim(botId, input);
    await gw.core.bots.run((s) => s.finish(turn, "completed", text));
  }

  async function waitForReply(outbound: typeof records.outbound, text: string) {
    expect(
      await eventually(
        async () => {
          session.pump();

          return (await outbound()).find((row) => row.text === text)?.status;
        },
        (status) => status === "sent",
      ),
    ).toBe("sent");
  }

  await receive("past", "<@UAPP> First question", "100.1");
  await reply(route.botId, "First question", "Historical reply");
  await waitForReply(records.outbound, "Historical reply");

  await receive("first-claim", "Next question", "100.2");
  await reply(route.botId, "Next question", "Claimed reply A");
  await receive("second-claim", "Another question", "100.3");
  await reply(route.botId, "Another question", "Claimed reply B");
  holdResponse();
  // The session claims a batch before sending serially. Hold the first Slack response
  // so deletion sees two claimed rows, including one whose HTTP request has yet to start.
  expect(
    await eventually(
      async () => {
        session.pump();

        return slack.sent.length;
      },
      (count) => count === 2,
    ),
  ).toBe(2);

  await receive("pending", "Pending question", "100.4");
  await reply(route.botId, "Pending question", "Pending reply");
  await receive("active", "Start active turn", "100.5");
  const active = await claim(route.botId, "Start active turn");
  await receive("attempted", "Attempted update", "100.6");
  const steers = await dispatch();
  expect(steers).toEqual([
    expect.objectContaining({ turnId: active.id, text: expect.stringContaining("Attempted update") }),
  ]);
  await receive("buffered", "Buffered update", "100.7");

  const [messages, inputs, turns, history, outbound] = await Promise.all([
    records.messages(),
    records.inputs(),
    records.turns(),
    records.history(),
    records.outbound(),
  ]);

  expect(messages.slice(-2)).toMatchObject([
    { text: "Attempted update", state: "attempted", deleted: false },
    { text: "Buffered update", state: "buffered", deleted: false },
  ]);
  expect(inputs.at(-1)).toMatchObject({ id: steers[0]!.id, status: "attempted" });
  expect(outbound).toMatchObject([
    { text: "Claimed reply A", status: "sending", lease_token: session.lease.token },
    { text: "Claimed reply B", status: "sending", lease_token: session.lease.token },
    { text: "Historical reply", status: "sent" },
    { text: "Pending reply", status: "pending", lease_token: null },
  ]);

  await gw.api.deleteBot({ botId: route.botId }, { timeoutMs: 5_000 });
  expect((await gw.api.listBotMessengerRoutes({ botId: survivor.botId })).routes).toEqual([survivor]);
  expect(await messenger.run((s) => s.routes(gw.userId, route.botId))).toEqual([]);

  releaseResponse();
  await messenger.run((s) => s.settleSteer(gw.userId, steers[0]!.id, true, active.id));
  await receive("stale", "<@UAPP> Follow-up to deleted bot", "100.8");
  expect(await dispatch()).toEqual([]);
  expect(await gw.core.bots.run((s) => s.claim(gw.userId))).toBeUndefined();

  const replacement = (await gw.api.saveBotMessengerRoute({ route: { ...survivor, channelIds: ["CGENERAL"] } })).route!;
  expect(replacement).toMatchObject({ id: survivor.id, accountId: route.accountId, channelIds: ["CGENERAL"] });
  await receive("old-thread", "Unmentioned reply to the old thread", "100.9");
  expect(await dispatch()).toEqual([]);
  expect(await gw.core.bots.run((s) => s.claim(gw.userId))).toBeUndefined();

  await receive("replacement", "<@UAPP> Question for the survivor", "300.1", "300.1");
  await reply(survivor.botId, "Question for the survivor", "Surviving bot reply");
  await waitForReply(deletionRecords(gw, survivor.botId, survivor.id).outbound, "Surviving bot reply");

  expect(slack.sent.map((post) => post.get("thread_ts"))).toEqual(["100.1", "100.1", "300.1"]);
  expect(slack.sent.at(-1)?.get("channel")).toBe("CGENERAL");
  expect(slack.sent.at(-1)?.get("text")).toBe("Surviving bot reply");
  expect((await gw.api.listMessengerAccounts({})).accounts).toMatchObject([
    { id: route.accountId, enabled: true, status: "connected" },
  ]);
  expect(await records.outbound()).toEqual([
    { text: "Claimed reply A", status: "uncertain", lease_token: null },
    { text: "Claimed reply B", status: "uncertain", lease_token: null },
    outbound[2]!,
    { text: "Pending reply", status: "failed", lease_token: null },
  ]);
  expect(await records.conversations()).toEqual([
    { id: active.conversation_id, retired: true, closed: true, first_received_at: null, last_received_at: null },
  ]);
  expect(await records.messages()).toEqual(messages.map((m) => ({ ...m, deleted: m.state !== "consumed" })));
  expect(await records.inputs()).toEqual(
    inputs.map((i) => ({ ...i, status: i.status === "attempted" ? "dropped" : i.status })),
  );
  expect(await records.turns()).toEqual(
    turns.map((t) => ({ ...t, status: t.id === active.id ? "interrupted" : t.status })),
  );
  expect(await records.history()).toEqual(history);
}

test.skipIf(!dockerAvailable)(
  "deleting an active Slack bot retires its route and keeps a shared account usable",
  async () => {
    const slack = slackMessengerFixture();
    const release = Promise.withResolvers<void>();
    let holdReplies = false;

    const transport = {
      ...slack.transport,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init);

        if (holdReplies && input instanceof URL && input.pathname.endsWith("/chat.postMessage")) await release.promise;

        return response;
      },
    };

    let gw: TestGateway | undefined;
    let session: MessengerAccountSession | undefined;

    try {
      const gateway = await startTestGateway({ messengerTransport: transport });
      gw = gateway;
      await gateway.core.bots.stop();
      const bot = (await addBot(gateway, "Delete Slack bot")).bot!;
      const survivor = (await addBot(gateway, "Keep Slack bot")).bot!;

      const accountId = (
        await gateway.api.saveMessengerAccount({
          name: "Shared Slack",
          appToken: "xapp-fixture",
          botToken: "xoxb-fixture",
        })
      ).account!.id;

      const saveRoute = (botId: string, channelId: string) =>
        gateway.api.saveBotMessengerRoute({
          route: {
            botId,
            accountId,
            channelIds: [channelId],
            userIds: ["UOWNER"],
            mentions: true,
            delivery: "reply",
          },
        });

      const deletedRoute = (await saveRoute(bot.id, "CGENERAL")).route!;
      const survivingRoute = (await saveRoute(survivor.id, "COTHER")).route!;
      const runtime = gateway.core.messengers;
      const lease = (await runtime.run((s) => s.claimAccount(gateway.userId, accountId, "test", runtime.now())))!;
      const account = (await runtime.run((s) => s.accounts(gateway.userId))).find((item) => item.id === accountId)!;
      const credentials = await runtime.run((s) => s.credentials(gateway.userId, accountId, transport));

      // Run the real account session and drive dispatch and pumping explicitly instead of using polling timers.
      session = new MessengerAccountSession(runtime, account, lease, credentials);
      expect(
        await eventually(
          async () => (await gateway.api.listMessengerAccounts({})).accounts[0]?.status,
          (status) => status === "connected",
        ),
      ).toBe("connected");

      await exerciseDeletion(
        gateway,
        slack,
        session,
        deletedRoute,
        survivingRoute,
        () => {
          holdReplies = true;
        },
        release.resolve,
      );
    } finally {
      release.resolve();

      try {
        await session?.close();
      } finally {
        try {
          await gw?.close();
        } finally {
          slack.close();
        }
      }
    }
  },
  30_000,
);
