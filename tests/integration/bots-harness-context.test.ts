import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Schema } from "effect";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

const Catalog = Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Json)) });
const HistoryEntry = Schema.Struct({ role: Schema.String, text: Schema.String });

/** Long messages around 90k characters; together they exceed the rebuild budget of the default window. */
const long = (marker: string) => `${marker} ${"lorem ipsum ".repeat(7_500)} ${marker}-END`;

describe.skipIf(!dockerAvailable)("bot context on the harness runtime", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  const turns = (botId: string) => f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${botId}/`));

  test("Codex bot catalog keeps the instance's model limits without its local tools", async () => {
    const bot = await f.add(Provider.CODEX);
    await f.send(bot.id, "Hello");
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");

    const catalog = Schema.decodeUnknownSync(Schema.fromJsonString(Catalog))(
      readFileSync(join(turns(bot.id)[0]!.home, "bot-model.json"), "utf8"),
    );

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: "fixture-model",
      context_window: 64_000,
      auto_compact_token_limit: 48_000,
      truncation_policy: { mode: "tokens", limit: 12_000 },
      shell_type: "disabled",
      apply_patch_tool_type: null,
      tool_mode: "direct",
      experimental_supported_tools: [],
    });
  });

  test("a rebuilt session gets the newest history within budget and the whole current input", async () => {
    const bot = await f.add(Provider.CODEX);
    const newest = long("FOURTH");
    const sent = [...["FIRST", "SECOND", "THIRD"].map(long), newest];

    for (const text of sent) {
      await f.send(bot.id, text);
      await f.settled(bot.id);
    }

    const before = turns(bot.id).at(-1)!;
    rmSync(join(before.home, "sessions", `${before.session}.json`));
    const current = `CURRENT ${"question ".repeat(3_500)} CURRENT-END`;
    await f.send(bot.id, current);
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect(turns(bot.id).at(-1)?.session).not.toBe(before.session);

    const prompt = readFileSync(join(before.home, "bot-input.txt"), "utf8");
    const [head, input] = prompt.split("\n\nCurrent input:\n");

    const history = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(HistoryEntry)))(
      head!.slice(head!.indexOf("\n") + 1),
    );

    expect(history[0]?.role).toBe("canopy_note");
    expect(history[0]?.text).toContain("5 earlier messages are omitted");
    expect(history.slice(1).map((m) => m.text)).toEqual(["FIXTURE_OK", newest, "FIXTURE_OK", current]);
    expect(input).toStartWith(`${current}\n\n`);
    // The default window is 128k tokens; half of it at three characters per token.
    expect(prompt.length).toBeLessThan(192_000 + 300);

    const transcript = await f.read(bot.id);
    expect(transcript.messages.map((m) => m.text)).toEqual([
      ...sent.flatMap((text) => [text, "FIXTURE_OK"]),
      current,
      "FIXTURE_OK",
    ]);
  }, 30_000);
});
