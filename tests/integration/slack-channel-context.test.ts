import { expect, test } from "bun:test";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SqlClient } from "effect/sql";
import { memoryFor } from "../../apps/gateway/src/memory/store.ts";
import type { ModelInput } from "../../apps/gateway/src/bots/types.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { slackMessengerFixture } from "./support/slack-messenger.ts";

const slackFixture = () => {
  const slack = slackMessengerFixture();
  let time = Date.now() + 1000;

  return {
    ...slack,
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
    waitFor: async (...ids: string[]) => {
      expect(await eventually(async () => ids.every((id) => slack.acknowledged.has(id)), Boolean)).toBe(true);
    },
  };
};

type SlackFixture = ReturnType<typeof slackFixture>;

async function connectChannel(gw: TestGateway, botId: string, slack: SlackFixture) {
  const { account } = await gw.api.saveMessengerAccount({
    name: "Fixture Slack",
    appToken: "xapp-fixture",
    botToken: "xoxb-fixture",
  });

  const { route } = await gw.api.saveBotMessengerRoute({
    route: {
      botId,
      accountId: account!.id,
      channelIds: ["CGENERAL", "COTHER"],
      userIds: ["UOWNER", "UALLOWED"],
      directMessages: false,
      mentions: true,
      observe: false,
      delivery: "reply",
      instructions: "Answer requests in the source conversation.",
    },
  });

  gw.core.messengers.start();

  expect(
    await eventually(
      async () =>
        (await gw.api.listMessengerAccounts({})).accounts.some((a) => a.id === account!.id && a.status === "connected"),
      Boolean,
    ),
  ).toBe(true);
  expect(slack.connected()).toBe(1);

  return route!;
}

const inputsOf = (f: HarnessBots) => f.inputs().map((input) => input.parts.map((part) => part.text ?? "").join("\n"));

async function checkOptOut(f: HarnessBots, slack: SlackFixture, route: ui.BotMessengerRoute) {
  const thread = "100.1";

  const [conversation] = await f.query<{ id: string }>(
    "SELECT id FROM bot_channel_conversations WHERE route_id=$1 AND thread_id=$2",
    [route.id, thread],
  );

  const title = "Seal inspection";
  const oldBody = "An older note before changing settings.";
  const body = "Inspect the finish in the new conversation.";
  await memoryFor(f.gw.runtime).save(
    f.gw.userId,
    { kind: "conversation", botId: route.botId, conversationId: conversation!.id },
    { title, body: oldBody },
  );
  slack.emit(
    "pending-optout",
    `<@UAPP> HOLD:optout question after turning capture off TOOL:memory_save\nARGS:${JSON.stringify({ scope: "conversation", title, body })}`,
    "300.1",
    thread,
  );
  await slack.waitFor("pending-optout");
  const saved = await f.gw.api.saveBotMessengerRoute({ route: { ...route, channelContext: false } });
  expect(saved.route?.channelContext).toBe(false);
  const { channelContext: omitted, ...oldClientRoute } = saved.route!;
  expect(omitted).toBe(false);
  expect((await f.gw.api.saveBotMessengerRoute({ route: oldClientRoute })).route?.channelContext).toBe(false);
  slack.advance(4000);
  await f.gw.core.messengers.tick();

  const started = await eventually(
    async () => inputsOf(f).find((text) => text.includes("question after turning capture off")),
    Boolean,
  );

  expect(started).toContain("question after turning capture off");
  expect(started).not.toContain("The blue casing");
  expect(started).not.toContain(oldBody);
  slack.emit("steer-optout", "Follow-up during opt-out", "300.2", thread);
  await slack.waitFor("steer-optout");
  slack.advance(4000);
  await f.gw.core.messengers.tick();
  expect(await eventually(async () => f.records().some((r) => r.event === "turn/steer"), Boolean)).toBe(true);
  await f.release("optout");
  expect(await eventually(async () => slack.sent[1]?.get("thread_ts"), Boolean)).toBe(thread);
  const optoutSession = f.records().findLast((event) => event.event === "turn")?.session;
  expect(optoutSession).toBeTruthy();

  slack.emit("search-optout", `TOOL:memory_search\nARGS:${JSON.stringify({ queries: [title] })}`, "300.3", thread);
  await slack.waitFor("search-optout");
  slack.advance(4000);
  await f.gw.core.messengers.tick();
  const answer = await eventually(async () => slack.sent[2]?.get("text"), Boolean);
  expect(answer).toContain(body);
  expect(answer).not.toContain(oldBody);
  expect(f.records().findLast((event) => event.event === "turn")?.session).toBe(optoutSession);
}

test.skipIf(!dockerAvailable)(
  "passive Slack capture feeds a real harness during analysis and restoring opt-out allows steer",
  async () => {
    const slack = slackFixture();
    const f = await harnessBots({ messengerTransport: slack.transport, botClock: slack.now });

    try {
      await f.save(Provider.CODEX, "slack-generation", ProviderProfileKind.NATIVE, "native", false, [
        { name: "FIXTURE_GENERATION_RESPONSE", value: '{"topics":[]}' },
      ]);
      const bot = await f.add(Provider.CODEX);
      await f.send(bot.id, "PRIVATE_OWNER_CONTEXT");
      expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
      const route = await connectChannel(f.gw, bot.id, slack);
      // A client that omits the additive field must leave the explicit opt-in in place.
      const { channelContext, ...olderRoute } = route;
      expect(channelContext).toBe(true);
      expect((await f.gw.api.saveBotMessengerRoute({ route: olderRoute })).route?.channelContext).toBe(true);

      slack.emit("first", "The blue casing is under review. HOLD:analysis", "100.1", null, [{ id: "FPASSIVE" }]);
      slack.emitEvent("thread", {
        user: "UALLOWED",
        ts: "100.2",
        thread_ts: "100.1",
        text: "The supplier can ship it Friday.",
      });
      slack.emit("back", "Friday works if the seal is matte.", "100.3", null);
      slack.emitEvent("different-channel", { channel: "COTHER", ts: "100.4", text: "OTHER_CHANNEL_CONTEXT" });
      slack.emitEvent("different-author", { user: "UOUTSIDE", ts: "100.5", text: "OUTSIDE_AUTHOR_CONTEXT" });
      await slack.waitFor("first", "thread", "back", "different-channel", "different-author");
      slack.advance(5000);
      await f.gw.core.messengers.tick();
      const pending = await eventually(async () => inputsOf(f).find((text) => text.includes("New messages:")), Boolean);
      expect(pending).toContain("HOLD:analysis");
      expect(await f.query("SELECT id FROM bot_turns WHERE conversation_id IS NOT NULL")).toEqual([]);

      slack.emit("message", "HOLD:shared Can we use that?", "100.6", "100.1");
      slack.emit("mention", "HOLD:shared Can we use that?", "100.6", "100.1", undefined, "app_mention");
      await slack.waitFor("message", "mention");
      slack.advance(4000);
      await f.gw.core.messengers.tick();

      const input = await eventually(
        async () => inputsOf(f).find((text) => text.includes("Can we use that?")),
        Boolean,
      );

      expect(input?.match(/Can we use that\?/g)).toHaveLength(1);
      expect(input).toContain('"message":"100.1","thread_root":null');
      expect(input).toContain('"message":"100.2","thread_root":"100.1","author":"UALLOWED"');
      expect(input).toContain('"message":"100.3","thread_root":null');
      expect(input).toContain("Friday works if the seal is matte.");

      for (const excluded of ["OTHER_CHANNEL_CONTEXT", "OUTSIDE_AUTHOR_CONTEXT", "PRIVATE_OWNER_CONTEXT", "FPASSIVE"])
        expect(input).not.toContain(excluded);

      expect(
        await f.query<{ delayed: boolean }>(
          "SELECT cursor=0 AND lease_id IS NOT NULL AS delayed FROM slack_channel_contexts WHERE channel_id='CGENERAL'",
        ),
      ).toEqual([{ delayed: true }]);
      slack.emitEvent("unknown-delete", { subtype: "message_deleted", deleted_ts: "99.9", user: "UOUTSIDE" });
      await slack.waitFor("unknown-delete");
      await f.release("shared");
      expect(
        await eventually(
          async () => slack.sent.map((post) => post.get("thread_ts")),
          (ids) => ids.length === 1,
        ),
      ).toEqual(["100.1"]);
      expect(slack.sent[0]?.get("channel")).toBe("CGENERAL");
      await f.release("analysis");
      await checkOptOut(f, slack, route);
    } finally {
      await f.release("analysis");
      await f.release("shared");
      await f.release("optout");
      await f.close();
      slack.close();
    }
  },
  40_000,
);

test.skipIf(!dockerAvailable)(
  "a saved Slack topic survives newer traffic and an edit immediately replaces its old evidence",
  async () => {
    const slack = slackFixture();
    const inputs: ModelInput[] = [];
    const title = "Falcon release sign-off";
    const summary = "Pending approval from operations before launch.";

    const gw = await startTestGateway({
      messengerTransport: slack.transport,
      botClock: slack.now,
      worker: { hello: { capabilities: ["generate_text"] } },
      botModel: async (input) => {
        inputs.push(input);

        return { text: inputs.length === 1 ? summary : "Correction acknowledged by the fixture", calls: [] };
      },
    });

    const generated: string[] = [];

    const recentTopics = ["Changelog review", "Ops hiring", "Icon draft"].map((name, index) => ({
      title: name,
      aliases: [],
      summary: "Needs a second opinion.",
      state: "open",
      sources: [`${210 + index}.1`],
    }));

    gw.worker.handlers.set("generateText", (command, reply) => {
      if ("prompt" in command) generated.push(command.prompt);
      reply(true, {
        generatedText: JSON.stringify({
          topics:
            generated.length === 1
              ? [{ title, aliases: ["falcon"], summary, state: "open", sources: ["100.1"] }]
              : recentTopics,
        }),
      });
    });

    const topics = () =>
      gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql<{ title: string; source_ids: string[] }>`SELECT title,source_ids FROM slack_channel_topics`,
        ),
      );

    const replies = () =>
      gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql<{ message_id: string; thread_id: string; text: string }>`
        SELECT message_id,thread_id,text FROM slack_channel_context_messages WHERE own_reply AND NOT deleted`,
        ),
      );

    try {
      const { bot } = await gw.api.createBot({
        clientRequestId: "topic-bot",
        configuration: {
          name: "Fixture bot",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          workerId: gw.workerId,
          approvalPolicy: "safe",
        },
      });

      await connectChannel(gw, bot!.id, slack);

      slack.emit("old", "The Falcon rollout is waiting on the operations team.", "100.1", null);
      await slack.waitFor("old");
      slack.advance(5000);
      await gw.core.messengers.tick();
      expect(await eventually(topics, (rows) => rows.length === 1)).toEqual([{ title, source_ids: ["100.1"] }]);
      expect(generated).toHaveLength(1);
      expect(generated[0]).toContain('"message":"100.1","thread_root":null');

      const noise = Array.from({ length: 30 }, (_, index) => `noise-${index}`);

      for (const [index, id] of noise.entries())
        slack.emit(id, `Updated inventory for shelf ${index}.`, `${210 + index}.1`, null);

      await slack.waitFor(...noise);
      slack.advance(60_000);
      await gw.core.messengers.tick();
      expect((await eventually(topics, (rows) => rows.length === 4)).map((row) => row.title)).toContain(title);
      expect(generated).toHaveLength(2);

      slack.emitEvent("hint", { user: "UALLOWED", ts: "299.1", text: "Checking in about Falcon." });
      slack.emit("lookup", "<@UAPP> Where did we leave that?", "300.1", null);
      await slack.waitFor("hint", "lookup");
      slack.advance(4000);
      await gw.core.messengers.tick();
      expect(await eventually(async () => inputs[0]?.memoryContext, Boolean)).toContain(summary);
      expect(inputs[0]?.memoryContext).toContain('"sources":["100.1"]');
      expect(inputs[0]?.memoryContext).not.toContain("The Falcon rollout is waiting");
      expect(await eventually(async () => slack.sent[0]?.get("thread_ts"), Boolean)).toBe("300.1");

      expect(await eventually(replies, (rows) => rows.length === 1)).toEqual([
        { message_id: "200.1", thread_id: "300.1", text: summary },
      ]);

      slack.emitEvent("edit", {
        subtype: "message_changed",
        event_ts: "301.1",
        message: { user: "UOWNER", ts: "100.1", edited: { ts: "301.1" }, text: "Correction: Falcon already shipped." },
      });
      await slack.waitFor("edit");
      expect((await topics()).map((row) => row.title).sort()).toEqual(recentTopics.map((row) => row.title).sort());
      expect(await replies()).toEqual([]);
      // An older edit and a redelivered original must not restore the original version.
      slack.emitEvent("stale-edit", {
        subtype: "message_changed",
        event_ts: "301.2",
        message: { user: "UOWNER", ts: "100.1", edited: { ts: "299.1" }, text: "STALE_VERSION" },
      });
      slack.emit("late-original", "The Falcon rollout is waiting on the operations team.", "100.1", null);
      await slack.waitFor("stale-edit", "late-original");
      slack.refuseNextSend("msg_too_long");
      slack.emit("fresh", "<@UAPP> Any update on Falcon?", "301.3", null);
      await slack.waitFor("fresh");
      slack.advance(4000);
      await gw.core.messengers.tick();
      const refreshed = await eventually(async () => inputs[1]?.memoryContext, Boolean);
      expect(refreshed).toContain("Correction: Falcon already shipped.");
      expect(refreshed).not.toContain("STALE_VERSION");
      expect(refreshed).not.toContain(summary);
      expect(refreshed).not.toContain("The Falcon rollout is waiting");

      const outbound = () =>
        gw.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql<{ status: string }>`
        SELECT status FROM messenger_outbound WHERE thread_id='301.3'`,
          ),
        );

      expect(await eventually(outbound, (rows) => rows[0]?.status === "failed")).toEqual([{ status: "failed" }]);
      expect(await replies()).toEqual([]);
    } finally {
      await gw.close();
      slack.close();
    }
  },
  25_000,
);
