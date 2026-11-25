import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { CommandSchema, Provider, TurnOutcome, type bots } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyBotConversation } from "@canopy/domain/bot-snapshot";
import { eventually } from "./support/gateway.ts";
import { harnessBots } from "./support/harness-bots.ts";

test.skipIf(!dockerAvailable)(
  "bot chat steers live text once and queues input without a consumption notice",
  async () => {
    const f = await harnessBots();

    try {
      const bot = await f.add(Provider.CODEX);
      const original = await f.send(bot.id, "HOLD:chat-steer");

      const session = await eventually(
        async () => f.records().find((record) => record.event === "turn")?.session ?? "",
        Boolean,
      );

      expect(session).not.toBe("");

      const request = { botId: bot.id, text: "Only check Safari.", clientRequestId: "chat-steer-once" };
      const [accepted, retry] = await Promise.all([f.gw.api.sendBotMessage(request), f.gw.api.sendBotMessage(request)]);
      expect(retry).toEqual(accepted);

      const attached = await eventually(
        () =>
          f.query<{ id: string; turn_id: string }>("SELECT id, turn_id FROM bot_messages WHERE text = $1", [
            request.text,
          ]),
        (rows) => rows[0]?.turn_id === original.turnId,
      );

      expect(attached).toHaveLength(1);
      expect(
        f
          .records()
          .filter((record) => record.event === "turn/steer")
          .map((record) => record.session),
      ).toEqual([session]);
      expect(f.inputs().at(-1)?.parts[0]?.text).toBe(`Owner message ID: ${attached[0]!.id}\n\n${request.text}`);

      const unconfirmed = "FIXTURE_UNCONFIRMED_BOT_STEER";
      const queued = await f.send(bot.id, unconfirmed);
      await eventually(
        async () => f.inputs().at(-1)?.parts[0]?.text,
        (text) => !!text?.endsWith(`\n\n${unconfirmed}`),
      );

      await f.release("chat-steer");
      const settled = await f.settled(bot.id);
      expect(settled.messages.map((message) => message.text)).toEqual([
        "HOLD:chat-steer",
        request.text,
        unconfirmed,
        "FIXTURE_OK",
        "FIXTURE_OK",
      ]);
      expect(f.records().filter((record) => record.event === "turn")).toHaveLength(2);
      expect(f.inputs().at(-1)?.parts[0]?.text).toContain(
        `Delivery of this message to the previous turn was unconfirmed. Do not repeat completed actions.\n\n${unconfirmed}`,
      );
      expect(await f.query("SELECT turn_id FROM bot_messages WHERE text = $1", [unconfirmed])).toEqual([
        { turn_id: queued.turnId },
      ]);
    } finally {
      await f.close();
    }
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "private chat input after a provider change waits for handoff and starts on the saved provider",
  async () => {
    const f = await harnessBots();

    try {
      const bot = await f.add(Provider.CLAUDE);
      const original = await f.send(bot.id, "HOLD:provider-change");
      expect(
        await eventually(
          async () => f.records().find((record) => record.event === "turn" && record.harness === "claude"),
          Boolean,
        ),
      ).toBeDefined();

      const configuration = { ...bot.configuration!, provider: Provider.CODEX, model: "other-model" };
      const updated = await f.gw.api.updateBot({ botId: bot.id, configuration });
      expect(updated.bot?.configuration).toMatchObject({ provider: Provider.CODEX, model: "other-model" });
      expect((await f.gw.api.getBot({ botId: bot.id })).bot?.configuration).toEqual(updated.bot?.configuration);

      const followup = "Continue with the newly selected model.";
      const next = await f.send(bot.id, followup);
      expect(await f.query("SELECT status, steer_target_id FROM bot_turns WHERE id = $1", [next.turnId])).toEqual([
        { status: "queued", steer_target_id: null },
      ]);
      await f.release("provider-change");
      const settled = await f.settled(bot.id);
      expect(settled.messages.at(-1)?.text).toBe("FIXTURE_OK");
      expect(await f.query("SELECT turn_id FROM bot_messages WHERE text = $1", [followup])).toEqual([
        { turn_id: next.turnId },
      ]);

      const commands = await f.query<{ payload: Uint8Array }>(
        `SELECT c.payload FROM bot_harness_turns h JOIN worker_commands c ON c.id = h.command_id
         JOIN bot_turns t ON t.id = h.turn_id WHERE h.bot_id = $1 ORDER BY c.created_at, t.id`,
        [bot.id],
      );

      expect(commands.map(({ payload }) => fromBinary(CommandSchema, payload).kind)).toEqual([
        {
          case: "runBotTurn",
          value: expect.objectContaining({
            provider: Provider.CLAUDE,
            model: "fixture-model",
            turnId: original.turnId,
          }),
        },
        {
          case: "runBotTurn",
          value: expect.objectContaining({ provider: Provider.CLAUDE, model: "fixture-model", tools: [] }),
        },
        {
          case: "runBotTurn",
          value: expect.objectContaining({
            provider: Provider.CODEX,
            profileId: "native",
            model: "other-model",
            turnId: next.turnId,
          }),
        },
      ]);
      expect(f.inputs().at(-1)).toMatchObject({
        harness: "codex",
        parts: [{ text: expect.stringContaining(followup) }],
      });
    } finally {
      await f.release("provider-change");
      await f.close();
    }
  },
  30_000,
);

for (const { provider, failure } of [
  { provider: Provider.CODEX, failure: false },
  { provider: Provider.CLAUDE, failure: true },
]) {
  test.skipIf(!dockerAvailable)(
    `${Provider[provider]} settles the reply and drains queued input even if steering cleanup cannot journal a notice`,
    async () => {
      const f = await harnessBots();

      try {
        const bot = await f.add(provider);
        const label = "steer-cleanup";
        const original = await f.send(bot.id, `HOLD:${label}${failure ? " FAIL:unavailable" : ""}`);
        const running = await eventually(async () => f.records().some((record) => record.event === "turn"), Boolean);
        expect(running).toBe(true);

        const followup = "FIXTURE_UNCONFIRMED_BOT_STEER";
        const queued = await f.send(bot.id, followup);

        const steered = await eventually(
          async () => f.inputs().at(-1)?.parts[0]?.text?.endsWith(followup) ?? false,
          Boolean,
        );

        expect(steered).toBe(true);

        // Only the auxiliary notice fails. The journal can still commit the terminal event.
        using journal = new Database(join(f.dir, "journal.db"));
        journal.exec(`CREATE TRIGGER reject_drop_notice BEFORE INSERT ON events
          WHEN instr(NEW.payload, CAST('bot_steer_dropped' AS BLOB)) > 0
          BEGIN SELECT RAISE(ABORT, 'fixture: cannot journal dropped steering input'); END`);

        const controller = new AbortController();
        let state: bots.BotConversation | undefined;

        try {
          for await (const update of f.gw.api.watchBotConversation(
            { botId: bot.id, incremental: true, pageSize: 50 },
            { signal: controller.signal, timeoutMs: 10_000 },
          )) {
            const first = !state;
            state = applyBotConversation(state, update);

            if (first) {
              expect(state).toMatchObject({ statusLine: "Typing…", working: true });
              await f.release(label);
            } else if (!state.working) break;
          }
        } finally {
          controller.abort();
        }

        expect(state).toMatchObject({ statusLine: "", working: false });
        const replies = state?.messages.filter((message) => message.senderId === bot.id) ?? [];
        expect(replies).toHaveLength(2);
        expect(replies[0]).toMatchObject(
          failure ? { failed: true, errorCode: "usage_limit", errorSource: "harness" } : { text: "FIXTURE_OK" },
        );
        expect(replies[1]).toMatchObject({ text: "FIXTURE_OK", failed: false });
        expect(f.logs).toContain("bots: steering cleanup failed");
        const ended = await f.gw.core.bots.run((s) => s.harnessTurn(original.turnId));
        expect(ended?.outcome).toBe(failure ? TurnOutcome.FAILED : TurnOutcome.COMPLETED);
        const next = await f.gw.core.bots.run((s) => s.harnessTurn(queued.turnId));
        expect(next?.outcome).toBe(TurnOutcome.COMPLETED);
        expect(f.records().filter((record) => record.event === "turn")).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
    30_000,
  );
}
