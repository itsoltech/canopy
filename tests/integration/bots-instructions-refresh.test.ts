import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Provider, type bots } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Schema } from "effect";
import { botContexts } from "./fixtures/bot-probe.ts";
import { eventually } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

const History = Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String }));

describe.skipIf(!dockerAvailable)("bot settings refresh the hidden harness, preserving the conversation", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  async function edit(id: string, patch: Partial<bots.BotConfiguration>) {
    const before = (await f.gw.api.getBot({ botId: id })).bot!.configuration!;
    const saved = await f.gw.api.updateBot({ botId: id, configuration: { ...before, ...patch } });
    expect(saved.bot?.configuration).toMatchObject(patch);
  }

  const sessions = (id: string) => f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${id}/`));

  async function probe(id: string, answer = "FIXTURE_OK") {
    await f.send(id, "PROBE_CONTEXT PROBE_INSTRUCTIONS Continue our conversation");
    const conversation = await f.settled(id);
    expect(conversation.bot!.id).toBe(id);
    expect(conversation.messages.at(-1)).toMatchObject({ text: answer, failed: false });

    return {
      conversation,
      context: botContexts(join(f.dir, "bots.jsonl.context")).at(-1)!,
      session: sessions(id).at(-1)!.session,
    };
  }

  function expectRebuilt(next: Awaited<ReturnType<typeof probe>>, prior: Awaited<ReturnType<typeof probe>>) {
    expect(next.session).not.toBe(prior.session);
    const json = next.context.prompt.split("\n\nCurrent input:\n")[0]!.split("never repeat them):\n")[1]!;
    const history = Schema.decodeSync(Schema.fromJsonString(History))(json);
    expect(history.slice(0, prior.conversation.messages.length)).toEqual(
      prior.conversation.messages.map((m) => ({
        role: m.senderId === prior.conversation.bot!.id ? "assistant" : "user",
        text: m.text,
      })),
    );
    expect(next.conversation.messages.slice(0, prior.conversation.messages.length)).toEqual(
      prior.conversation.messages,
    );
  }

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} edits and clearing instructions apply after resume and worker/gateway restarts`, async () => {
      const bot = await f.add(provider);
      await edit(bot.id, { instructions: "FIXTURE_REPLY:OLD" });
      const first = await probe(bot.id, "OLD");
      const resumed = await probe(bot.id, "OLD");
      expect(resumed.session).toBe(first.session);
      expect(resumed.context.prompt).not.toContain("Conversation history from Canopy");

      // Existing durable notes remain context after a fresh provider session and after both restarts.
      await f.query(
        `INSERT INTO bot_handoff_notes(turn_id,bot_id,model,note)
         SELECT id,bot_id,'fixture-model','Remember the project decision: keep the green door'
         FROM bot_turns WHERE bot_id=$1 ORDER BY created_at LIMIT 1`,
        [bot.id],
      );
      await edit(bot.id, { instructions: "FIXTURE_REPLY:NEW" });
      const edited = await probe(bot.id, "NEW");
      expectRebuilt(edited, resumed);
      expect(edited.context.instructions).toContain("FIXTURE_REPLY:NEW");
      expect(edited.context.instructions).not.toContain("FIXTURE_REPLY:OLD");
      expect(edited.context.instructions).toContain("keep the green door");

      await f.restartWorker();
      const same = await probe(bot.id, "NEW");
      expect(same.session).toBe(edited.session);

      await edit(bot.id, { instructions: "FIXTURE_REPLY:RESTARTED" });
      await f.restartWorker();
      const restarted = await probe(bot.id, "RESTARTED");
      expectRebuilt(restarted, same);
      expect(restarted.context.instructions).toContain("keep the green door");

      await edit(bot.id, { instructions: "" });
      await f.restartGateway();
      f.gw.core.bots.start();
      await f.reconnect();
      const cleared = await probe(bot.id);
      expectRebuilt(cleared, restarted);
      expect(cleared.context.instructions).not.toContain("FIXTURE_REPLY:");
      expect(cleared.context.instructions).toContain("keep the green door");
      expect((await probe(bot.id)).session).toBe(cleared.session);
    }, 45_000);

    test(`${Provider[provider]} name, policy, effort and model refresh; appearance and no-op saves resume`, async () => {
      const bot = await f.add(provider);
      const first = await probe(bot.id);
      await edit(bot.id, { color: "#ff3344", shape: "round" });
      const appearance = await probe(bot.id);
      expect(appearance.session).toBe(first.session);
      await edit(bot.id, {});
      const unchanged = await probe(bot.id);
      expect(unchanged.session).toBe(first.session);

      await edit(bot.id, { name: `Renamed ${provider}` });
      const renamed = await probe(bot.id);
      expectRebuilt(renamed, unchanged);
      expect(renamed.context.instructions).toContain(`You are Renamed ${provider},`);

      let prior = renamed;

      const patches: Partial<bots.BotConfiguration>[] = [
        { approvalPolicy: "always" },
        { effort: "low" },
        { model: "other-model" },
      ];

      for (const patch of patches) {
        await edit(bot.id, patch);
        await f.settled(bot.id);
        const next = await probe(bot.id);
        expectRebuilt(next, prior);
        prior = next;
      }
    }, 30_000);

    test(`${Provider[provider]} an edit during a turn takes effect on the next turn`, async () => {
      const bot = await f.add(provider);
      await edit(bot.id, { instructions: "FIXTURE_REPLY:RUNNING" });
      const label = `instruction-edit-${provider}`;
      await f.send(bot.id, `PROBE_CONTEXT PROBE_INSTRUCTIONS HOLD:${label}`);
      await eventually(
        async () => sessions(bot.id).length,
        (n) => n === 1,
      );
      const active = sessions(bot.id)[0]!.session;
      await edit(bot.id, { instructions: "FIXTURE_REPLY:AFTER" });
      await f.release(label);
      const finished = await f.settled(bot.id);
      expect(finished.messages.at(-1)?.text).toBe("RUNNING");
      const next = await probe(bot.id, "AFTER");
      expect(next.session).not.toBe(active);
      expect(next.conversation.messages.slice(0, finished.messages.length)).toEqual(finished.messages);
    }, 20_000);
  }
});
