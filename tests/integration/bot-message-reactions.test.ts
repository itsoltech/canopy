import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually, failure } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

describe.skipIf(!dockerAvailable)("private bot message reactions", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  test("adding and removing steer the active private turn once per change", async () => {
    const bot = await f.add(Provider.CODEX);
    await f.send(bot.id, "Is the review complete?");
    const [owner, reply] = (await f.settled(bot.id)).messages;
    expect(reply?.reactionsAvailable).toBe(true);
    const request = { botId: bot.id, messageId: reply!.id, emoji: "❤️", active: true };
    const other = await f.add(Provider.CODEX);

    for (const invalid of [
      { ...request, botId: other.id },
      { ...request, messageId: owner!.id },
      { ...request, emoji: "invalid" },
    ])
      expect(await failure(f.gw.api.setBotMessageReaction(invalid))).toMatch(/not_found|invalid_argument/);

    const launches = () => f.records().filter((record) => record.event === "turn").length;
    const before = launches();
    await f.send(bot.id, "HOLD:reaction-steer");

    try {
      expect(
        await eventually(
          async () => launches(),
          (n) => n > before,
        ),
      ).toBe(before + 1);
      await Promise.all([f.gw.api.setBotMessageReaction(request), f.gw.api.setBotMessageReaction(request)]);
      expect((await f.read(bot.id)).messages.find((m) => m.id === reply!.id)?.reactions).toEqual(["❤️"]);

      const notices = () =>
        f
          .inputs()
          .flatMap((input) =>
            input.parts.flatMap(({ text }) => (text?.includes(reply!.id) && text.includes("❤️") ? [text] : [])),
          );

      const added = await eventually(
        async () => notices(),
        (inputs) => inputs.length > 0,
      );

      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(/added/i);
      await f.gw.api.setBotMessageReaction({ ...request, active: false });

      const both = await eventually(
        async () => notices(),
        (inputs) => inputs.length > 1,
      );

      expect(both).toHaveLength(2);
      expect(both[1]).toMatch(/removed/i);

      const applied = await eventually(
        () =>
          f.query<{ id: string }>(
            "SELECT id FROM bot_turns WHERE bot_id=$1 AND reaction_input AND status='completed' AND steer_target_id IS NOT NULL",
            [bot.id],
          ),
        (rows) => rows.length === 2,
      );

      expect(applied).toHaveLength(2);
    } finally {
      await f.release("reaction-steer");
    }

    const done = await f.settled(bot.id);
    expect(launches()).toBe(before + 1);
    expect(done.messages.map((message) => message.text)).toEqual([
      "Is the review complete?",
      "FIXTURE_OK",
      "HOLD:reaction-steer",
      "FIXTURE_OK",
    ]);
    expect(done.messages.find((message) => message.id === reply!.id)?.reactions).toEqual([]);
  }, 30_000);

  test("a queued reaction reaches the private harness and its rebuilt history without a chat reply", async () => {
    const bot = await f.add(Provider.CODEX);
    await f.send(bot.id, "The deployment is done.");
    const before = await f.settled(bot.id);
    const target = before.messages.at(-1)!;
    const request = { botId: bot.id, messageId: target.id, emoji: "👍", active: true };
    await f.gw.api.setBotMessageReaction(request);
    await f.gw.api.setBotMessageReaction(request);

    const turns = await eventually(
      () =>
        f.query<{ input: string; status: string }>(
          "SELECT input,status FROM bot_turns WHERE bot_id=$1 AND reaction_input",
          [bot.id],
        ),
      (rows) => rows.length === 1 && rows[0]!.status === "completed",
    );

    expect(turns.map((turn) => turn.status)).toEqual(["completed"]);
    const notice = turns[0]!.input;
    expect(notice).toContain(target.id);
    expect(f.inputs().at(-1)?.parts[0]?.text).toContain(notice);
    expect((await f.read(bot.id)).messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));

    await f.send(bot.id, "What was my feedback?");
    await f.settled(bot.id);
    const rebuilt = f.inputs().at(-1)?.parts[0]?.text ?? "";
    expect(rebuilt.split("\n\nCurrent input:\n")[0]).toContain(JSON.stringify(notice));
  }, 30_000);

  test("a bot can acknowledge an owner message with just a reaction", async () => {
    const bot = await f.add(Provider.CODEX);
    await f.send(bot.id, "The fix worked.");
    const previous = await f.settled(bot.id);
    const target = previous.messages[0]!;
    const args = { message_id: target.id, emoji: "👍" };
    const prompt = `FIXTURE_SILENT_AFTER_TOOL\nTOOL:react_to_message\nARGS:${JSON.stringify(args)}`;
    await f.send(bot.id, prompt);
    const done = await f.settled(bot.id);
    expect(done.messages.find((message) => message.id === target.id)?.reactions).toEqual(["👍"]);
    expect(done.messages.map((message) => message.text)).toEqual([...previous.messages.map((m) => m.text), prompt]);

    await f.gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, files: false } });
    await f.send(bot.id, "Which message did you acknowledge?");
    await f.settled(bot.id);
    const history = f.inputs().at(-1)?.parts[0]?.text?.split("\n\nCurrent input:\n")[0];
    expect(history).toContain(
      JSON.stringify({ role: "user", message_id: target.id, bot_reactions: ["👍"], text: target.text }),
    );
  }, 30_000);
});
