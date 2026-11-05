import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Schema } from "effect";
import { botContexts } from "./fixtures/bot-probe.ts";
import { fakeConnector } from "./support/connector.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

const History = Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String }));

describe.skipIf(!dockerAvailable)("connector changes refresh bot sessions without losing history", () => {
  let f: HarnessBots;
  const connector = fakeConnector();

  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    connector.close();
    await f?.close();
  });

  const sessions = (id: string) => f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${id}/`));

  async function probe(id: string) {
    await f.send(id, "PROBE_CONTEXT Continue this conversation");
    const conversation = await f.settled(id);
    expect(conversation.bot!.id).toBe(id);
    expect(conversation.messages.at(-1)?.text).toBe("FIXTURE_OK");
    const context = botContexts(join(f.dir, "bots.jsonl.context")).at(-1)!;
    expect(context).toBeDefined();

    return { conversation, context, session: sessions(id).at(-1)!.session };
  }

  async function access(id: string, allBots: boolean, botIds: string[] = []) {
    const account = (await f.gw.api.listConnectors({})).accounts.find((a) => a.id === id)!;
    await f.gw.api.setConnectorAccess({ accountId: id, expectedRevision: account.revision, allBots, botIds });
  }

  function rebuilt(prompt: string) {
    const json = prompt.split("\n\nCurrent input:\n")[0]!.split("never repeat them):\n")[1]!;
    expect(json).toBeDefined();

    return Schema.decodeSync(Schema.fromJsonString(History))(json);
  }

  function expectHistory(prompt: string, prior: Awaited<ReturnType<HarnessBots["read"]>>) {
    const expected = prior.messages.map((m) => ({
      role: m.senderId === prior.bot!.id ? "assistant" : "user",
      text: m.text,
    }));

    expect(rebuilt(prompt).slice(0, expected.length)).toEqual(expected);
  }

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} add, revoke, grant and remove rebuild the same conversation with all history`, async () => {
      const bot = await f.add(provider);
      await f.send(bot.id, "Remember the earliest user message");
      const first = await f.settled(bot.id);
      expect(first.messages.at(-1)?.text).toBe("FIXTURE_OK");
      const initialSession = sessions(bot.id).at(-1)!.session;

      // More than 60 prior messages protect the normal-turn history contract without 60 CLI launches.
      await f.query(
        `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text)
         SELECT gen_random_uuid(),bot_id,id,'history:' || n,
                CASE WHEN n % 2 = 0 THEN bot_id::text ELSE 'user' END,bot_id::text,'Earlier message ' || n
         FROM bot_turns CROSS JOIN generate_series(1,64) n WHERE bot_id=$1 AND status='completed'`,
        [bot.id],
      );
      const prior = (await f.read(bot.id)).messages;
      expect(prior).toHaveLength(66);
      const same = await probe(bot.id);
      expect(same.session).toBe(initialSession);
      expect(same.context.prompt).not.toContain("Conversation history from Canopy");

      const account = (
        await f.gw.api.saveConnectorAccount({
          connectorType: "custom",
          name: `Refresh ${Provider[provider]}`,
          url: connector.url,
          token: connector.secret,
        })
      ).account!;

      await access(account.id, true);
      const added = await probe(bot.id);
      expect(added.session).not.toBe(initialSession);
      const names = (await f.gw.api.testConnector({ accountId: account.id })).tools.map((t) => t.name);
      expect(names).toHaveLength(2);
      expect(added.context.names).toEqual(expect.arrayContaining(names));
      const history = rebuilt(added.context.prompt);
      expectHistory(added.context.prompt, same.conversation);
      expect(history[0]).toEqual({ role: "user", text: "Remember the earliest user message" });
      expect(history[1]).toEqual({ role: "assistant", text: "FIXTURE_OK" });
      expect(added.conversation.messages.slice(0, prior.length)).toEqual(prior);

      await access(account.id, false);
      const revoked = await probe(bot.id);
      expect(revoked.session).not.toBe(added.session);

      for (const name of names) expect(revoked.context.names).not.toContain(name);
      expectHistory(revoked.context.prompt, added.conversation);

      await access(account.id, false, [bot.id]);
      const granted = await probe(bot.id);
      expect(granted.session).not.toBe(revoked.session);
      expect(granted.context.names).toEqual(expect.arrayContaining(names));
      expectHistory(granted.context.prompt, revoked.conversation);

      await f.gw.api.deleteConnectorAccount({ accountId: account.id });
      const removed = await probe(bot.id);
      expect(removed.session).not.toBe(granted.session);

      for (const name of names) expect(removed.context.names).not.toContain(name);
      expectHistory(removed.context.prompt, granted.conversation);
      expect(JSON.stringify(botContexts(join(f.dir, "bots.jsonl.context")))).not.toContain(connector.secret);
    }, 30_000);
  }
});
