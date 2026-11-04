import { describe, expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { bots, MentionKind, ProfileModelsSchema, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import type { ModelInput } from "../../apps/gateway/src/bots/types.ts";
import { eventually, failure } from "./support/gateway.ts";
import { botsSuite, reply, tool, lastInput } from "./support/bots.ts";

describe.skipIf(!dockerAvailable)("gateway bots: durable conversations, exchanges and approvals", () => {
  const { suite, configuration, add, read, settled, send, restart } = botsSuite();

  test("create/list/update and one idempotent conversation stream, hidden from Threads", async () => {
    suite.model = async (i) => reply(`Reply: ${lastInput(i)}`);
    const requestId = Bun.randomUUIDv7();
    const request = { configuration: configuration("First"), clientRequestId: requestId };
    const a = (await suite.gw.api.createBot(request)).bot!;
    expect((await suite.gw.api.createBot(request)).bot!.id).toBe(a.id);
    expect((await suite.gw.api.listBots({})).bots.some((b) => b.id === a.id)).toBe(true);
    const updated = await suite.gw.api.updateBot({ botId: a.id, configuration: configuration("Renamed") });
    expect(updated.bot?.configuration?.name).toBe("Renamed");
    const sendRequest = { botId: a.id, text: "hello", clientRequestId: Bun.randomUUIDv7() };
    const first = await suite.gw.api.sendBotMessage(sendRequest);
    expect((await suite.gw.api.sendBotMessage(sendRequest)).turnId).toBe(first.turnId);
    expect((await settled(a.id)).messages.map((m) => m.text)).toEqual(["hello", "Reply: hello"]);
    await send(a.id, "second");
    expect((await settled(a.id)).messages.at(-1)?.text).toBe("Reply: second");
    expect((await suite.gw.api.listBots({})).bots.find((b) => b.id === a.id)?.lastMessage?.text).toBe("Reply: second");
    const abort = new AbortController();

    for await (const snapshot of suite.gw.api.watchBotConversation({ botId: a.id }, { signal: abort.signal })) {
      expect(snapshot.messages).toHaveLength(4);
      break;
    }

    abort.abort();
    expect((await suite.gw.api.listThreads({})).threads).toHaveLength(0);
    const otherUser = Bun.randomUUIDv7();
    await expect(suite.gw.runtime.runPromise(BotStore.use((s) => s.owned(otherUser, a.id)))).rejects.toThrow();
  });

  test("queued messages retain the preceding reply even when their input was saved earlier", async () => {
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const seen: string[][] = [];
    suite.model = async (i) => {
      seen.push(i.messages.map((m) => m.text));

      if (lastInput(i) === "first queued") {
        started.resolve();
        await proceed.promise;
      }

      return reply(`Answer: ${lastInput(i)}`);
    };

    const bot = await add("Queue history");
    await send(bot.id, "first queued");
    await started.promise;
    await send(bot.id, "second queued");
    proceed.resolve();
    await settled(bot.id);
    expect(seen).toEqual([["first queued"], ["first queued", "Answer: first queued", "second queued"]]);
  });

  test("structured bot mentions and quotes are durable, validated and unambiguous to the model", async () => {
    const seen: ModelInput[] = [];
    suite.model = async (input) => {
      seen.push(input);

      return reply("ok");
    };

    const bot = await add("Mention author");
    const target = await add("Kropek");
    const legacyDuplicate = await add("Legacy Kropek");
    // Old data may contain identical names; new creates/updates enforce unique names.
    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE bots SET configuration = jsonb_set(configuration, '{name}', '"Kropek"'::jsonb) WHERE id = ${legacyDuplicate.id}::uuid`;
      }),
    );
    const text = "🙂 ask @Kropek how he's doing";

    const mention = {
      kind: MentionKind.BOT,
      name: target.id,
      label: "Kropek",
      start: text.indexOf("@"),
      end: text.indexOf("@") + "@Kropek".length,
    };

    const quotes = [
      {
        text: "Wątek został zarchiwizowany.\nStatus: interrupted",
        comment: "Czy możesz zapytać o ten wynik?",
        sourceItemId: Bun.randomUUIDv7(),
        sourceThreadId: bot.id,
        sourceKind: "agent_message",
      },
    ];

    const request = { botId: bot.id, text, mentions: [mention], quotes, clientRequestId: Bun.randomUUIDv7() };
    const accepted = await suite.gw.api.sendBotMessage(request);
    const stored = (await settled(bot.id)).messages[0]!;
    expect(stored.text).toBe(text);
    expect(stored.quotes[0]?.text).toBe(quotes[0]!.text);
    expect(stored.quotes[0]?.comment).toBe(quotes[0]!.comment);
    expect(stored.quotes[0]?.sourceItemId).toBe(quotes[0]!.sourceItemId);
    expect(stored.mentions.map((m) => [m.kind, m.name, m.label, m.start, m.end])).toEqual([
      [MentionKind.BOT, target.id, "Kropek", mention.start, mention.end],
    ]);
    expect(lastInput(seen[0]!)).toContain(text);
    expect(lastInput(seen[0]!)).toContain(`"Kropek" (bot_id ${target.id})`);
    expect(lastInput(seen[0]!)).toContain("> Wątek został zarchiwizowany.\n> Status: interrupted");
    expect(lastInput(seen[0]!)).toContain(`Comment: ${quotes[0]!.comment}`);
    await send(bot.id, "and now?");
    await settled(bot.id);
    expect(seen[1]!.messages[0]!.text).toContain(`bot_id ${target.id}`);
    expect(seen[1]!.messages[0]!.text).toContain(quotes[0]!.comment);

    const foreign = await add("Foreign");

    const otherUser = await suite.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("mentions-other@test.local", "Other")),
    );

    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE bots SET owner_user_id = ${otherUser}::uuid WHERE id = ${foreign.id}::uuid`;
      }),
    );

    const invalid = [
      [{ ...mention, name: foreign.id }],
      [{ ...mention, name: Bun.randomUUIDv7() }],
      [{ ...mention, name: bot.id }],
      [{ ...mention, kind: MentionKind.SKILL }],
      [{ ...mention, name: "invalid-id" }],
      [{ ...mention, start: mention.start + 1 }],
      [{ ...mention, end: text.length + 1 }],
      [mention, mention],
      Array.from({ length: 51 }, () => mention),
    ];

    for (const mentions of invalid)
      expect(
        await failure(suite.gw.api.sendBotMessage({ ...request, mentions, clientRequestId: Bun.randomUUIDv7() })),
      ).not.toBe("");
    expect((await read(bot.id)).messages.filter((m) => m.senderId === "user")).toHaveLength(2);

    for (const invalidQuotes of [
      [{ text: " " }],
      [{ text: "x", sourceKind: "unknown" }],
      [{ text: "x".repeat(20_001) }],
      [{ text: "x", comment: "x".repeat(4_001) }],
      Array.from({ length: 21 }, () => ({ text: "x" })),
    ])
      expect(
        await failure(
          suite.gw.api.sendBotMessage({ ...request, quotes: invalidQuotes, clientRequestId: Bun.randomUUIDv7() }),
        ),
      ).not.toBe("");
    await suite.gw.api.sendBotMessage({ botId: bot.id, text: "", quotes, clientRequestId: Bun.randomUUIDv7() });
    const quoteOnly = (await settled(bot.id)).messages.find((m) => m.senderId === "user" && m.text === "");
    expect(quoteOnly?.quotes[0]?.text).toBe(quotes[0]!.text);
    // The displayed name is untrusted input; model context comes from the selected owner's bot.
    await suite.gw.api.sendBotMessage({
      ...request,
      text: "@Spoof",
      mentions: [{ ...mention, label: "Spoof", start: 0, end: 6 }],
      clientRequestId: Bun.randomUUIDv7(),
    });
    expect((await settled(bot.id)).messages.find((m) => m.text === "@Spoof")?.mentions[0]?.label).toBe("Kropek");
    expect(lastInput(seen.at(-1)!)).toContain(`"Kropek" (bot_id ${target.id})`);
    await suite.gw.api.deleteBot({ botId: target.id });
    expect((await suite.gw.api.sendBotMessage(request)).turnId).toBe(accepted.turnId);
    expect(await failure(suite.gw.api.sendBotMessage({ ...request, clientRequestId: Bun.randomUUIDv7() }))).not.toBe(
      "",
    );
  }, 20_000);

  test("gateway restart mid-inference resumes its durable input without duplicate messages", async () => {
    const started = Promise.withResolvers<void>();
    suite.model = async (input) => {
      started.resolve();
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      input.signal.throwIfAborted();

      return reply("unreachable");
    };

    const bot = await add("Restart");
    await send(bot.id, "survive restart");
    await started.promise;
    expect((await read(bot.id)).statusLine).toBe("Typing…");
    await suite.current.bots.stop();
    suite.model = async (i) => reply(`Recovered: ${lastInput(i)}`);
    await restart();
    expect((await settled(bot.id)).messages.map((m) => m.text)).toEqual([
      "survive restart",
      "Recovered: survive restart",
    ]);
  });

  test("bot exchanges enqueue a target reply and a follow-up, preserving the hop limit", async () => {
    const a = await add("A");
    const b = await add("B");
    suite.model = async (i) =>
      i.configuration.name === "B"
        ? reply("B says hello")
        : lastInput(i).startsWith("Message from")
          ? reply("Received B's reply")
          : i.messages.at(-1)?.role === "tool"
            ? reply("Sent")
            : tool("send_bot_message", { bot_id: b.id, text: "hello B" });
    await send(a.id, "ask B");

    const result = await eventually(
      () => read(a.id),
      (s) => s.messages.some((m) => m.text === "Received B's reply"),
      10_000,
    );

    expect(result.messages.some((m) => m.text.includes("Message from B"))).toBe(true);
    const exchangeId = result.messages.find((m) => m.exchangeId)!.exchangeId;
    expect((await suite.current.bots.exchange(exchangeId)).some((m) => m.text === "B says hello")).toBe(true);
    await suite.current.bots.run((s) => s.enqueue(suite.gw.userId, a.id, "automated", Bun.randomUUIDv7(), { hops: 7 }));
    expect((await settled(a.id)).working).toBe(false);
    expect((await read(b.id)).messages.filter((m) => m.text.includes("hello B"))).toHaveLength(1);
  }, 20_000);

  test("durable one-shot wakeups deliver once and cancellation prevents a turn", async () => {
    const bot = await add("Reminders");
    suite.model = async (i) =>
      lastInput(i) === "Reminder prompt"
        ? reply("Reminder received")
        : i.messages.at(-1)?.role === "tool"
          ? reply("Scheduled")
          : tool("schedule_wakeup", { run_at: new Date(Date.now() + 1500).toISOString(), prompt: "Reminder prompt" });
    await send(bot.id, "remind me");

    const received = await eventually(
      () => read(bot.id),
      (s) => s.messages.some((m) => m.text === "Reminder received"),
      10_000,
    );

    expect(received.messages.filter((m) => m.text === "Reminder prompt")).toHaveLength(1);
    suite.model = async (i) => {
      const last = i.messages.at(-1);

      if (last?.role === "tool") {
        const result = JSON.parse(last.text) as { schedule_id?: string };

        return result.schedule_id ? tool("cancel_schedule", { schedule_id: result.schedule_id }) : reply("Cancelled");
      }

      return tool("schedule_wakeup", { run_at: new Date(Date.now() + 60_000).toISOString(), prompt: "Must not run" });
    };

    await send(bot.id, "cancel reminder");

    const pending = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: pending.approvals.find((a) => a.status === "pending")!.id,
        approve: true,
      }),
    );
    await settled(bot.id);
    const schedules = await suite.current.bots.run((s) => s.wakeups(bot.id));
    expect(schedules.some((s) => s["cancelled"] === true)).toBe(true);
  }, 15_000);

  test("an expired lease cannot commit an old model answer after another gateway takes over", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    suite.model = async () => {
      entered.resolve();
      await release.promise;

      return reply("Stale answer");
    };

    const bot = await add("Fenced");
    await send(bot.id, "take over");
    await entered.promise;
    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE bot_turns SET lease_until = now() - interval '1 second' WHERE bot_id = ${bot.id}::uuid AND status = 'running'`;
      }),
    );

    const competitor = new GatewayCore({
      runtime: suite.gw.runtime,
      userId: suite.gw.userId,
      instanceId: "competitor",
      botModel: async () => reply("New owner answer"),
    });

    try {
      await competitor.bots.tick();
      expect((await settled(bot.id)).messages.at(-1)?.text).toBe("New owner answer");
      release.resolve();
      await suite.current.bots.stop();
      expect((await read(bot.id)).messages.filter((m) => m.senderId === bot.id).map((m) => m.text)).toEqual([
        "New owner answer",
      ]);
    } finally {
      release.resolve();
      await competitor.bots.stop();
      suite.current.bots.start();
    }
  }, 15_000);

  test("questions persist and approvals resume after a gateway restart; interrupt and delete work", async () => {
    const bot = await add("Questions");
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply(i.messages.at(-1)!.text)
        : tool("ask_user", { question: "Which project?", options: ["CRM", "Docs"] });
    await send(bot.id, "question");

    const pending = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    expect(pending.approvals[0]!.options).toEqual(["CRM", "Docs"]);
    await restart();
    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: pending.approvals[0]!.id,
        approve: true,
        answer: "CRM",
      }),
    );
    expect((await settled(bot.id)).messages.at(-1)?.text).toContain("CRM");
    await send(bot.id, "another question");
    await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );
    await suite.current.bots.interrupt(bot.id);
    expect((await read(bot.id)).working).toBe(false);
    await suite.current.bots.remove(bot.id);
    expect((await suite.current.bots.list()).some((b) => b.id === bot.id)).toBe(false);
  }, 20_000);
  test("harness aliases stay intact; failed replies are marked and can be retried", async () => {
    await suite.gw.api.saveProviderInstance({
      harness: Provider.CLAUDE,
      id: "bots-claude",
      label: "Claude proxy",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });

    const catalog = create(ProfileModelsSchema, {
      provider: Provider.CLAUDE,
      profileId: "bots-claude",
      models: [{ id: "default", resolvedModel: "claude-opus-5-5", isDefault: true }, { id: "claude-sonnet-5-5" }],
    });

    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A worker of its own: the connected scripted worker replaces its catalog on every config push.
        const workerId = Bun.randomUUIDv7();
        yield* sql`INSERT INTO workers (id, name, credential_hash) VALUES (${workerId}::uuid, 'catalog only', 'unused')`;
        yield* sql`INSERT INTO worker_model_catalogs (worker_id, config_version, profiles) VALUES (${workerId}::uuid, 1, ${JSON.stringify([toJson(ProfileModelsSchema, catalog)])}::jsonb)`;
      }),
    );
    const claude = { provider: Provider.CLAUDE, providerInstance: "bots-claude" };
    const saved = await add("Aliased", { ...claude, model: "default" });
    expect(saved.configuration?.model).toBe("default");

    const create_ = (name: string, model: string) =>
      suite.current.bots.create(
        create(bots.CreateBotRequestSchema, {
          configuration: configuration(name, { ...claude, model }),
          clientRequestId: Bun.randomUUIDv7(),
        }),
      );

    await expect(create_("Unresolved", "sonnet")).rejects.toThrow(/matching model/);
    await expect(create_("Unknown", "claude-missing")).rejects.toThrow(/matching model/);
    expect(
      (
        await suite.gw.api.updateBot({
          botId: saved.id,
          configuration: configuration("Aliased", { ...claude, model: "default" }),
        })
      ).bot?.configuration?.model,
    ).toBe("default");

    // The official harness resolves its own aliases, including definitions saved before migration.
    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE bots SET configuration = jsonb_set(configuration, '{model}', '"default"') WHERE id = ${saved.id}::uuid`;
      }),
    );
    const models: string[] = [];
    let fail = true;
    suite.model = async (i) => {
      models.push(i.configuration.model);

      if (fail) throw new Error("Model endpoint returned HTTP 400");

      return reply("Back again");
    };

    await send(saved.id, "hello alias");
    const failed = await settled(saved.id);
    expect(models).toEqual(["default"]);
    expect(failed.messages.at(-1)).toMatchObject({ failed: true, text: "Model endpoint returned HTTP 400" });
    expect((await suite.current.bots.list()).find((b) => b.id === saved.id)?.lastMessage?.failed).toBe(true);
    fail = false;
    await suite.gw.api.retryBot({ botId: saved.id });

    const retried = await eventually(
      () => read(saved.id),
      (s) => s.messages.at(-1)?.text === "Back again",
      10_000,
    );

    expect(retried.messages.map((m) => [m.text, m.failed])).toEqual([
      ["hello alias", false],
      ["Back again", false],
    ]);
    await expect(suite.current.bots.retry(saved.id)).rejects.toThrow(/failed/);
  }, 20_000);
  test("an edited approval card runs nothing and hands the user's version back to the model", async () => {
    const bot = await add("Editor");
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply(i.messages.at(-1)!.text)
        : tool("archive_thread", { thread_id: Bun.randomUUIDv7() });
    await send(bot.id, "archive it");

    const pending = await eventually(
      () => read(bot.id),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    expect(pending.approvals[0]!.prompt).toStartWith("Needs approval");
    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: pending.approvals[0]!.id,
        approve: false,
        answer: "Archive the other thread instead",
      }),
    );
    const result = JSON.parse((await settled(bot.id)).messages.at(-1)!.text) as { status: string; edited: string };
    expect(result).toMatchObject({ status: "changes_requested", edited: "Archive the other thread instead" });
  }, 15_000);
});
