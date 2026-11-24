import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
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
