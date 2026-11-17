import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create, toJson } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { exportBot } from "../../apps/gateway/src/computers/move-source.ts";
import { botRowsJson } from "../../apps/gateway/src/computers/move-payload.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import type { AccountLease, MessengerEvent, SaveMessengerRoute } from "../../apps/gateway/src/messengers/types.ts";

function services(db: TestPostgres, key: Buffer) {
  return ManagedRuntime.make(
    Layer.mergeAll(BotStore.layer(key), MessengerStore.layer(key)).pipe(Layer.provideMerge(db.layer)),
  );
}

describe.skipIf(!dockerAvailable)("durable bot messenger channels", () => {
  let db: TestPostgres;
  let runtime: ReturnType<typeof services>;
  const key = randomBytes(32);
  const owner = Bun.randomUUIDv7();
  const other = Bun.randomUUIDv7();

  const run = <A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(MessengerStore.use(use));

  const botRun = <A, E>(use: (store: BotStore["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(BotStore.use(use));

  const query = <A extends object>(statement: string, values: readonly (string | number)[] = []) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(statement, values)));

  beforeAll(async () => {
    db = await startPostgres({ migrated: true });
    runtime = services(db, key);

    for (const id of [owner, other])
      await query("INSERT INTO users(id,email,display_name,role) VALUES($1,$2,'Messenger test','user')", [
        id,
        `${id}@example.test`,
      ]);
  });
  afterAll(async () => {
    await runtime?.dispose();
    await db?.stop();
  });

  const addBot = async () => {
    const id = Bun.randomUUIDv7();

    const configuration = toJson(
      bots.BotConfigurationSchema,
      create(bots.BotConfigurationSchema, {
        name: "Messenger bot",
        provider: Provider.CODEX,
        providerInstance: "native",
        model: "fixture-model",
        shape: "round",
        color: "#22aaff",
      }),
    );

    await query(
      "INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) VALUES($1::uuid,$2::uuid,$1::text,$3::jsonb,'codex','native')",
      [id, owner, JSON.stringify(configuration)],
    );

    return id;
  };

  const fixture = async (options: Partial<SaveMessengerRoute> = {}) => {
    const botId = await addBot();

    const account = await run((s) =>
      s.saveAccount(owner, {
        name: "Workspace",
        externalId: Bun.randomUUIDv7(),
        appToken: "xapp-fixture",
        botToken: "xoxb-fixture",
      }),
    );

    const route = await run((s) =>
      s.saveRoute(owner, {
        botId,
        accountId: account.id,
        channelIds: ["C123"],
        userIds: ["U123", "U456"],
        directMessages: true,
        mentions: true,
        observe: false,
        delivery: "reply",
        instructions: "Use a concise, helpful tone.",
        ...options,
      }),
    );

    const now = new Date();
    const lease = (await run((s) => s.claimAccount(owner, account.id, "gateway-a", now)))!;
    await query("UPDATE messenger_accounts SET lease_until=now()+interval '1 day' WHERE id=$1", [account.id]);

    const event = (id: string, text: string, patch: Partial<MessengerEvent> = {}): MessengerEvent => ({
      id,
      accountId: account.id,
      channelId: "C123",
      threadId: "1700.000001",
      messageId: id,
      authorId: "U123",
      text,
      timestamp: "9999999999.000001",
      mention: true,
      direct: false,
      ...patch,
    });

    const at = (ms: number) => new Date(now.getTime() + ms);

    const ingest = (id: string, text: string, ms = 0, patch: Partial<MessengerEvent> = {}) =>
      run((s) => s.ingest(owner, event(id, text, patch), lease, at(ms)));

    const dispatch = (ms: number) => run((s) => s.dispatch(owner, at(ms)));

    const turns = () =>
      query<BotTurn>("SELECT * FROM bot_turns WHERE bot_id=$1 AND conversation_id IS NOT NULL ORDER BY created_at,id", [
        botId,
      ]);

    return { botId, account, route, lease, now, at, event, ingest, dispatch, turns };
  };

  test("credentials are encrypted and owner scoped; leases fence stale gateways and route responders", async () => {
    const f = await fixture();
    expect(JSON.stringify(await run((s) => s.accounts(owner)))).not.toContain("xapp-");
    expect(await run((s) => s.accounts(other))).toEqual([]);
    await expect(run((s) => s.credentials(other, f.account.id))).rejects.toThrow();

    const sealed = await query<{ ciphertext: string }>(
      "SELECT encode(credentials,'escape') AS ciphertext FROM messenger_accounts WHERE id=$1",
      [f.account.id],
    );

    expect(sealed[0]?.ciphertext).not.toContain("xoxb-fixture");
    expect(await run((s) => s.claimAccount(owner, f.account.id, "gateway-b", f.now))).toBeUndefined();
    const lease = (await run((s) => s.claimAccount(owner, f.account.id, "gateway-b", f.at(2 * 86_400_000))))!;
    expect(lease.token).not.toBe(f.lease.token);
    expect(await run((s) => s.renewAccount(owner, f.lease, f.at(2 * 86_400_000)))).toBe(false);
    await expect(
      run((s) => s.ingest(owner, f.event("stale", "ignored"), f.lease, f.at(2 * 86_400_000))),
    ).rejects.toThrow();
    const secondBot = await addBot();
    const { id: _routeId, ...binding } = f.route;
    await expect(run((s) => s.saveRoute(owner, { ...binding, botId: secondBot }))).rejects.toThrow();
    await expect(run((s) => s.saveRoute(other, binding))).rejects.toThrow();
    expect(
      (await run((s) => s.saveRoute(owner, { ...binding, botId: secondBot, observe: true, delivery: "notify" }))).botId,
    ).toBe(secondBot);
  });

  test("receipt clocks, restart recovery, root thread followups and external/private history stay isolated", async () => {
    const f = await fixture();
    const privateId = await botRun((s) => s.enqueue(owner, f.botId, "PRIVATE OWNER SECRET", Bun.randomUUIDv7()));
    const privateTurn = (await botRun((s) => s.claim(owner)))!;
    expect(privateTurn.id).toBe(privateId);
    await botRun((s) => s.finish(privateTurn, "completed", "PRIVATE ANSWER"));
    await f.ingest("1700.000001", "Mention root", 0, { threadId: "" });
    await f.ingest("1700.000002", "Same author fragment", 2000, { threadId: "", mention: false });
    await f.ingest("1700.000003", "Other author unrelated root", 2200, {
      threadId: "",
      mention: false,
      authorId: "U456",
    });
    await f.ingest("1700.000004", "Reply inside canonical thread", 2500, { mention: false, authorId: "U456" });
    expect(await f.dispatch(3000)).toEqual([]);
    expect(await f.turns()).toHaveLength(0);
    await runtime.dispose();
    runtime = services(db, key);
    await f.dispatch(5500);
    const turns = await f.turns();
    expect(turns).toHaveLength(1);
    const external = (await botRun((s) => s.claim(owner)))!;
    expect(external.conversation_id).toBe(turns[0]!.conversation_id);
    const history = await botRun((s) => s.history(external));
    expect(JSON.stringify(history)).toContain("Same author fragment");
    expect(JSON.stringify(history)).toContain("Reply inside canonical thread");
    expect(JSON.stringify(history)).not.toContain("PRIVATE");
    expect(JSON.stringify(history)).not.toContain("Other author unrelated root");
    expect((await botRun((s) => s.conversation(owner, f.botId))).messages.map((m) => m.text)).toEqual([
      "PRIVATE OWNER SECRET",
      "PRIVATE ANSWER",
    ]);
    await botRun((s) => s.finish(external, "completed", "EXTERNAL ANSWER"));
    expect((await botRun((s) => s.list(owner))).map((bot) => bot.lastMessage?.text).join("\n")).not.toContain(
      "EXTERNAL ANSWER",
    );
    const outgoing = await run((s) => s.outbound(owner, f.lease, f.at(6000)));
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.threadId).toBe("1700.000001");
    expect(await run((s) => s.outbound(owner, f.lease, f.at(6000)))).toEqual([]);
    await run((s) => s.settleOutbound(owner, f.lease, outgoing[0]!.id, { sent: true }, f.at(6000)));
    expect(await run((s) => s.outbound(owner, f.lease, f.at(7000)))).toEqual([]);
    await f.ingest("unrelated-thread", "SECOND CONVERSATION", 8000, { threadId: "1800.000001" });
    await f.dispatch(11_000);
    const second = (await botRun((s) => s.claim(owner)))!;
    const secondHistory = JSON.stringify(await botRun((s) => s.history(second)));
    expect(secondHistory).toContain("SECOND CONVERSATION");
    expect(secondHistory).not.toContain("EXTERNAL ANSWER");
    expect(secondHistory).not.toContain("Mention root");
    await botRun((s) => s.finish(second, "completed", ""));
    await botRun((s) => s.enqueue(owner, f.botId, "Private after channel work", Bun.randomUUIDv7()));
    const laterPrivate = (await botRun((s) => s.claim(owner)))!;
    const privateHistory = JSON.stringify(await botRun((s) => s.history(laterPrivate)));
    expect(privateHistory).toContain("PRIVATE OWNER SECRET");
    expect(privateHistory).not.toContain("SECOND CONVERSATION");
    expect(privateHistory).not.toContain("EXTERNAL ANSWER");
    expect(await botRun((s) => s.handoffContext(laterPrivate))).not.toContain("SECOND CONVERSATION");
    await botRun((s) => s.finish(laterPrivate, "completed", ""));
  });

  test("max receipt wait flushes a noisy batch; provider duplicates and edits/deletes do not repeat actions", async () => {
    const f = await fixture();

    for (const [index, ms] of [0, 2000, 4000, 6000, 8000, 9000].entries())
      await f.ingest(`message-${index}`, `body-${index}`, ms);
    await f.ingest("duplicate-event", "body-0", 9500, { messageId: "message-0" });
    await f.ingest("edit", "edited body", 9600, { kind: "edit", messageId: "message-1" });
    await f.ingest("delete", "", 9700, { kind: "delete", messageId: "message-2" });
    await f.dispatch(9999);
    expect(await f.turns()).toHaveLength(0);
    await f.dispatch(10_000);
    const turn = (await botRun((s) => s.claim(owner)))!;
    expect(turn.input).toContain("edited body");
    expect(turn.input).not.toContain("body-2");
    expect(turn.input.match(/body-0/g)).toHaveLength(1);
    await botRun((s) => s.finish(turn, "completed", "done"));
    await f.ingest("late-edit", "do not execute", 12_000, { kind: "edit", messageId: "message-0" });
    await f.dispatch(20_000);
    expect(await f.turns()).toHaveLength(1);
  });

  test("unknown and dropped steers fall back only after completion; attempted commands never replay", async () => {
    const f = await fixture();
    await f.ingest("first", "start");
    await f.dispatch(3000);
    const turn = (await botRun((s) => s.claim(owner)))!;
    await f.ingest("followup", "retained unconfirmed text", 4000, { mention: false });
    const inputs = await f.dispatch(7000);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.turnId).toBe(turn.id);
    await runtime.dispose();
    runtime = services(db, key);
    expect(await f.dispatch(8000)).toEqual([]);
    await botRun((s) => s.finish(turn, "completed", "first answer"));
    await f.dispatch(11_000);
    const fallback = (await botRun((s) => s.claim(owner)))!;
    expect(fallback.input).toContain("unconfirmed");
    expect(fallback.input).toContain("retained unconfirmed text");
    await f.ingest("drop", "unsupported steering text", 12_000, { mention: false });
    const dropped = (await f.dispatch(15_000))[0]!;
    await run((s) => s.settleSteer(owner, dropped.id, false));
    expect(await f.dispatch(16_000)).toEqual([]);
    await botRun((s) => s.finish(fallback, "completed", "second answer"));
    await f.dispatch(20_000);
    const next = (await botRun((s) => s.claim(owner)))!;
    expect(next.input).toContain("unsupported steering text");
    expect(next.input).not.toContain("unconfirmed");
    await botRun((s) => s.finish(next, "completed", "done"));
  });

  test("observers steer active work without the new-turn cooldown and notify only explicit summaries", async () => {
    const f = await fixture({ observe: true, delivery: "notify" });
    await f.ingest("observed", "observed content", 0, { mention: false, threadId: "" });
    await f.dispatch(9999);
    expect(await f.turns()).toHaveLength(0);
    await f.dispatch(10_000);
    const first = (await botRun((s) => s.claim(owner)))!;
    await f.ingest("live-observed", "live observer update", 11_000, { mention: false, threadId: "" });
    const steer = (await f.dispatch(21_000))[0]!;
    expect(steer.turnId).toBe(first.id);
    await run((s) => s.settleSteer(owner, steer.id, true));
    expect(JSON.stringify(await botRun((s) => s.history(first)))).toContain("live observer update");
    await botRun((s) => s.finish(first, "completed", "Owner summary"));
    const visible = await botRun((s) => s.conversation(owner, f.botId));
    expect(visible.messages.map((m) => m.text)).toEqual(["Owner summary"]);

    const notification = (
      await query<BotTurn>(
        "SELECT t.* FROM bot_turns t JOIN bot_messages m ON m.turn_id=t.id WHERE m.bot_id=$1 AND m.message_key='notify'",
        [f.botId],
      )
    )[0]!;

    expect(notification.conversation_id).toBeNull();
    expect(await run((s) => s.outbound(owner, f.lease, f.at(22_000)))).toEqual([]);
    await f.ingest("later", "next observation", 30_000, { mention: false, threadId: "" });
    await f.dispatch(40_000);
    expect(await f.turns()).toHaveLength(1);
    await f.dispatch(70_000);
    const later = (await botRun((s) => s.claim(owner)))!;
    await botRun((s) => s.finish(later, "completed", "Later summary"));
  });

  test("bounded batches retain every Unicode fragment and unknown outbound sends never repeat", async () => {
    const f = await fixture();
    const text = "🌲".repeat(20_000) + "TAIL PRESERVED";
    await f.ingest("large", text);
    let combined = "";

    for (let round = 0; round < 10; round++) {
      await f.dispatch(3000 + round * 4000);
      const turn = await botRun((s) => s.claim(owner));

      if (!turn) break;
      expect(Buffer.byteLength(turn.input)).toBeLessThanOrEqual(32_000);
      combined += turn.input;
      await botRun((s) => s.finish(turn, "completed", "fragment reply"));
    }

    expect(combined).toContain("TAIL PRESERVED");
    expect(combined.match(/🌲/gu)).toHaveLength(20_000);
    const pending = await run((s) => s.outbound(owner, f.lease, f.at(50_000)));
    expect(pending.length).toBeGreaterThan(0);
    await run((s) => s.releaseAccount(owner, f.lease));

    const nextLease: AccountLease = (await run((s) =>
      s.claimAccount(owner, f.account.id, "restarted-gateway", f.at(50_000)),
    ))!;

    expect(await run((s) => s.outbound(owner, nextLease, f.at(50_000)))).toEqual([]);

    const statuses = await query<{ status: string }>("SELECT status FROM messenger_outbound WHERE account_id=$1", [
      f.account.id,
    ]);

    expect(statuses.every((row) => row.status === "uncertain")).toBe(true);
    const notes = (await botRun((s) => s.conversation(owner, f.botId))).messages;
    expect(notes).toHaveLength(pending.length);
    expect(notes.every((message) => message.text.includes("Check Slack before resending"))).toBe(true);
    await run((s) => s.outbound(owner, nextLease, f.at(51_000)));
    expect((await botRun((s) => s.conversation(owner, f.botId))).messages).toHaveLength(notes.length);
  });
  test("explicit send refusal creates one owner notice and retains the complete response audit", async () => {
    const f = await fixture();
    await f.ingest("refused", "Reply please");
    await f.dispatch(3000);
    const turn = (await botRun((s) => s.claim(owner)))!;
    const response = "Response body ".repeat(1000);
    await botRun((s) => s.finish(turn, "completed", response));
    const outgoing = (await run((s) => s.outbound(owner, f.lease, f.at(4000))))[0]!;
    await run((s) => s.settleOutbound(owner, f.lease, outgoing.id, { sent: false, refused: true }, f.at(5000)));
    await run((s) => s.settleOutbound(owner, f.lease, outgoing.id, { sent: false, refused: true }, f.at(5000)));
    const visible = await botRun((s) => s.conversation(owner, f.botId));
    expect(visible.messages).toHaveLength(1);
    expect(visible.messages[0]!.text).toContain("The reply was not sent");
    expect(visible.messages[0]!.text).not.toContain("could not be confirmed");
    expect(
      (await query<{ text: string }>("SELECT text FROM messenger_outbound WHERE id=$1", [outgoing.id]))[0]!.text,
    ).toBe(response);
  });
  test("moving a bot exports private turns and intentional notices without raw channel data", async () => {
    const gw = await startTestGateway();

    try {
      const bot = await gw.core.bots.create(
        create(bots.CreateBotRequestSchema, {
          clientRequestId: Bun.randomUUIDv7(),
          configuration: {
            name: "Moving messenger bot",
            provider: Provider.CODEX,
            providerInstance: "native",
            model: "gpt-6.1-sol",
            shape: "round",
            color: "#22aaff",
          },
        }),
      );

      const botId = bot.id;

      const botStore = <A, E>(use: (store: BotStore["Service"]) => Effect.Effect<A, E>) =>
        gw.runtime.runPromise(BotStore.use(use));

      const messenger = <A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
        gw.runtime.runPromise(MessengerStore.use(use));

      await botStore((s) => s.enqueue(gw.userId, botId, "PRIVATE MOVE HISTORY", Bun.randomUUIDv7()));
      const privateTurn = (await botStore((s) => s.claim(gw.userId)))!;
      await botStore((s) => s.finish(privateTurn, "completed", "Private response"));

      const account = await messenger((s) =>
        s.saveAccount(gw.userId, {
          name: "Move account",
          externalId: "TMOVE:BMOVE",
          appToken: "xapp-fixture",
          botToken: "xoxb-fixture",
        }),
      );

      await messenger((s) =>
        s.saveRoute(gw.userId, {
          botId,
          accountId: account.id,
          channelIds: ["CMOVE"],
          userIds: ["UMOVE"],
          directMessages: false,
          mentions: true,
          observe: false,
          delivery: "notify",
          instructions: "Summarize",
        }),
      );
      const now = new Date();
      const lease = (await messenger((s) => s.claimAccount(gw.userId, account.id, "move-gateway", now)))!;
      await messenger((s) =>
        s.ingest(
          gw.userId,
          {
            id: "move-event",
            accountId: account.id,
            channelId: "CMOVE",
            threadId: "",
            messageId: "move-message",
            authorId: "UMOVE",
            text: "RAW CHANNEL MOVE CONTENT",
            timestamp: "100.1",
            mention: true,
            direct: false,
          },
          lease,
          now,
        ),
      );
      await messenger((s) => s.dispatch(gw.userId, new Date(now.getTime() + 3000)));
      const external = (await botStore((s) => s.claim(gw.userId)))!;
      expect(external.conversation_id).toBeTruthy();
      await botStore((s) => s.finish(external, "completed", "Intentional owner summary"));
      const exported = await exportBot(new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), botId, "Source");
      const payload = botRowsJson(exported.rowsJson);
      expect(payload.turns.every((turn) => turn["conversation_id"] === null)).toBe(true);
      expect(exported.rowsJson).toContain("PRIVATE MOVE HISTORY");
      expect(exported.rowsJson).toContain("Intentional owner summary");
      expect(exported.rowsJson).not.toContain("RAW CHANNEL MOVE CONTENT");
      expect(payload.turns.some((turn) => turn["id"] === external.id)).toBe(false);
    } finally {
      await gw.close();
    }
  });
  test("revoked channels stop active replies and pending outbound delivery", async () => {
    for (const beforeFinish of [true, false]) {
      const f = await fixture();
      await f.ingest(`revoke-${beforeFinish}`, "Channel content before revocation");
      await f.dispatch(3000);
      const turn = (await botRun((s) => s.claim(owner)))!;

      if (!beforeFinish) await botRun((s) => s.finish(turn, "completed", "Pending external reply"));
      await run((s) => s.saveRoute(owner, { ...f.route, channelIds: [] }));

      if (beforeFinish) await botRun((s) => s.finish(turn, "completed", "Late external reply"));
      expect(await run((s) => s.outbound(owner, f.lease, f.at(4000)))).toEqual([]);
    }

    const f = await fixture();
    await f.ingest("revoked-author", "Discard this buffered input");
    await run((s) => s.saveRoute(owner, { ...f.route, userIds: ["U456"] }));
    await f.dispatch(3000);
    expect(await f.turns()).toHaveLength(0);
    await run((s) => s.saveRoute(owner, f.route));
    await f.dispatch(4000);
    expect(await f.turns()).toHaveLength(0);
  });
  test("delivery notices keep bot locks before account locks during subscription changes", async () => {
    for (const recovering of [false, true]) {
      const f = await fixture();
      await f.ingest(`concurrent-${recovering}`, "Reply before changing the subscription");
      await f.dispatch(3000);
      const external = (await botRun((s) => s.claim(owner)))!;
      await botRun((s) => s.finish(external, "completed", "External response"));
      const outgoing = (await run((s) => s.outbound(owner, f.lease, f.at(4000))))[0]!;
      let lease = f.lease;

      if (recovering) {
        await run((s) => s.releaseAccount(owner, f.lease));
        lease = (await run((s) => s.claimAccount(owner, f.account.id, "gateway-restarted", f.at(5000))))!;
      }

      await botRun((s) => s.enqueue(owner, f.botId, "Change my subscription", Bun.randomUUIDv7()));
      const privateTurn = (await botRun((s) => s.claim(owner)))!;

      const call = await botRun((s) =>
        s.planCall(
          privateTurn,
          Bun.randomUUIDv7(),
          {
            name: "save_messenger_subscription",
            description: "Save the approved subscription",
            parameters: {},
            source: "platform",
          },
          {},
        ),
      );

      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const editing = runtime.runPromise(
        BotStore.use((s) =>
          s.action(
            privateTurn,
            call,
            Effect.gen(function* () {
              locked.resolve();
              yield* Effect.promise(() => release.promise);
              yield* MessengerStore.use((store) =>
                store.saveRoute(owner, { ...f.route, instructions: "Updated owner instructions" }),
              );

              return { saved: true };
            }),
          ),
        ),
      );

      await locked.promise;
      const label = `messenger-lock-${Bun.randomUUIDv7()}`;

      const delivering = runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT set_config('application_name',${label},true)`;
              yield* sql`SET LOCAL lock_timeout='2s'`;

              if (recovering) yield* MessengerStore.use((store) => store.outbound(owner, lease, f.at(6000)));
              else
                yield* MessengerStore.use((store) =>
                  store.settleOutbound(owner, lease, outgoing.id, { sent: false, uncertain: true }, f.at(6000)),
                );
            }),
          );
        }),
      );

      const completed = Promise.allSettled([editing, delivering]);

      try {
        const waiting = await eventually(
          async () =>
            (
              await query<{ waiting: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
                [label],
              )
            )[0]!.waiting,
          Boolean,
          1500,
        );

        expect(waiting).toBe(true);
      } finally {
        release.resolve();
        const outcomes = await completed;
        expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      }

      expect((await run((s) => s.routes(owner, f.botId)))[0]!.instructions).toBe("Updated owner instructions");

      const notices = await query<{ text: string }>(
        "SELECT m.text FROM bot_messages m JOIN bot_turns t ON t.id=m.turn_id WHERE t.bot_id=$1 AND t.client_request_id=$2",
        [f.botId, `messenger-delivery:${outgoing.id}`],
      );

      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain("Check Slack before resending");

      if (recovering) expect(await run((s) => s.outbound(owner, lease, f.at(7000)))).toEqual([]);
      else await run((s) => s.settleOutbound(owner, lease, outgoing.id, { sent: false, uncertain: true }, f.at(7000)));
      expect(
        (
          await query<{ count: string }>(
            "SELECT count(*)::text AS count FROM bot_turns WHERE bot_id=$1 AND client_request_id=$2",
            [f.botId, `messenger-delivery:${outgoing.id}`],
          )
        )[0]!.count,
      ).toBe("1");
      await botRun((s) => s.finish(privateTurn, "completed", "Subscription saved"));
    }
  });
});
