import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { applyBotConversation, applyBotExchange } from "@canopy/domain/bot-snapshot";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot UI checkpoints on real gateways", () => {
  let a: TestGateway;
  let b: TestGateway | undefined;
  let la: LinkedComputers | undefined;
  let lb: LinkedComputers | undefined;
  let botId: string;
  let exchangeId: string;
  let state: bots.BotConversation;
  const query = <T extends object>(sql: string, params: unknown[] = []) => a.core.linkedAgents.query<T>(sql, params);

  async function open(gw: TestGateway, id = botId, cursor = "", incremental = true) {
    const abort = new AbortController();

    try {
      for await (const snapshot of gw.api.watchBotConversation(
        { botId: id, incremental, cursor },
        { signal: abort.signal, timeoutMs: 10000 },
      ))
        return snapshot;
      throw new Error("Missing bot state");
    } finally {
      abort.abort();
    }
  }

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    botId = (
      await a.api.createBot({
        configuration: {
          name: "Long chat",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
        },
        clientRequestId: crypto.randomUUID(),
      })
    ).bot!.id;
    exchangeId = crypto.randomUUID();
    await query(
      `INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,reply_to_bot_id,exchange_id)
      SELECT gen_random_uuid(),$1::uuid,'delta-'||n,'input','completed',$1::uuid,$2::uuid FROM generate_series(1,1000) n`,
      [botId, exchangeId],
    );
    await query(
      `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text,exchange_id)
      SELECT gen_random_uuid(),bot_id,id,'answer',bot_id::text,'user',repeat('long output ',100),exchange_id FROM bot_turns WHERE bot_id=$1::uuid`,
      [botId],
    );
  }, 60000);

  afterAll(async () => {
    await la?.close();
    await lb?.close();
    await b?.close();
    await a?.close();
  });

  test("reopen transfers edits, failures and deletions without replaying history; control state is confirmed", async () => {
    state = await open(a);
    expect(state.messages).toHaveLength(1000);
    const unchanged = await open(a, botId, state.cursor);
    expect(unchanged.delta).toBe(true);
    expect(unchanged.controlsUnchanged).toBe(true);
    expect(toBinary(bots.BotConversationSchema, unchanged).length).toBeLessThan(1024);
    expect(applyBotConversation(state, unchanged)).toEqual(state);
    const edited = state.messages[0]!;
    const removed = state.messages[1]!;
    await query("UPDATE bot_messages SET text='edited' WHERE id=$1::uuid", [edited.id]);
    await query("UPDATE bot_turns SET status='failed' WHERE id=(SELECT turn_id FROM bot_messages WHERE id=$1::uuid)", [
      edited.id,
    ]);
    await query("DELETE FROM bot_messages WHERE id=$1::uuid", [removed.id]);
    await a.api.markBotRead({ botId, throughSeq: state.messages.at(-1)!.seq });
    const delta = await open(a, botId, state.cursor);
    expect(delta.delta).toBe(true);
    expect(delta.messages).toHaveLength(1);
    state = applyBotConversation(state, delta);
    expect(state.messages.find((m) => m.id === edited.id)?.text).toBe("edited");
    expect(state.messages.some((m) => m.id === removed.id)).toBe(false);
    expect(state.bot?.unreadCount).toBe(0);
    expect(state).toEqual(await open(a));
    expect((await open(a, botId, "", false)).cursor).toBe("");
    expect((await open(a, botId, "", false)).messages).toHaveLength(999);
  });

  test("owner/view binding and invalid, missing, expired and other-epoch cursors fall back safely", async () => {
    const other = crypto.randomUUID();
    await expect(a.core.bots.run((s) => s.conversation(other, botId, state.cursor))).rejects.toThrow();

    for (const cursor of [
      "unknown",
      state.cursor.replace(/^[^:]+/, other),
      state.cursor.replace("chat:", "exchange:"),
    ]) {
      const full = await open(a, botId, cursor);
      expect(full.delta).toBe(false);
      expect(full.messages).toHaveLength(999);
    }

    const before = state.cursor;
    await query("UPDATE bots SET revision=revision+1 WHERE id=$1::uuid", [botId]);
    await query(
      "DELETE FROM bot_view_changes WHERE owner_user_id=$1::uuid AND revision=(SELECT max(revision) FROM bot_view_changes WHERE owner_user_id=$1::uuid)",
      [a.userId],
    );
    expect((await open(a, botId, before)).delta).toBe(false);
    state = await open(a);
    await query("UPDATE bot_view_clock SET epoch=gen_random_uuid() WHERE owner_user_id=$1::uuid", [a.userId]);
    expect((await open(a, botId, state.cursor)).delta).toBe(false);
    state = await open(a);
  });

  test("exchanges use durable deltas and never disclose another owner's messages", async () => {
    const full = await a.api.readBotExchange({ exchangeId, incremental: true });
    expect(full.messages).toHaveLength(999);
    const first = full.messages[0]!;
    const unchanged = await a.api.readBotExchange({ exchangeId, incremental: true, cursor: full.cursor });
    expect(unchanged.controlsUnchanged).toBe(true);
    expect(unchanged.participants).toHaveLength(0);
    expect(applyBotExchange(full, unchanged)).toEqual(full);
    await query("UPDATE bot_messages SET text='exchange edit' WHERE id=$1::uuid", [first.id]);
    const delta = await a.api.readBotExchange({ exchangeId, incremental: true, cursor: full.cursor });
    expect(delta.delta).toBe(true);
    expect(delta.messages).toHaveLength(1);
    const result = applyBotExchange(full, delta);
    expect(result.messages.find((m) => m.id === first.id)?.text).toBe("exchange edit");
    expect(result).toEqual(await a.api.readBotExchange({ exchangeId, incremental: true }));
    await query(
      "UPDATE bots SET configuration=jsonb_set(configuration,'{name}','\"Renamed bot\"'),revision=revision+1 WHERE id=$1::uuid",
      [botId],
    );
    const renamed = await a.api.readBotExchange({ exchangeId, incremental: true, cursor: delta.cursor });
    expect(renamed.messages).toHaveLength(0);
    expect(renamed.controlsUnchanged).toBe(false);
    expect(applyBotExchange(result, renamed).participants[0]?.configuration?.name).toBe("Renamed bot");
    const foreign = await a.core.bots.run((s) => s.exchangeView(crypto.randomUUID(), exchangeId, full.cursor));
    expect(foreign.messages).toHaveLength(0);
    expect(foreign.delta).toBe(false);
    const unknown = await a.api.readBotExchange({ exchangeId, incremental: true, cursor: "old" });
    expect(unknown.messages).toHaveLength(999);
    await query(
      "UPDATE bot_turns SET reply_to_bot_id=NULL WHERE id=(SELECT turn_id FROM bot_messages WHERE id=$1::uuid)",
      [first.id],
    );
    const rewritten = await a.api.readBotExchange({ exchangeId, incremental: true, cursor: delta.cursor });
    expect(rewritten.delta).toBe(false);
    expect(rewritten.messages.some((m) => m.id === first.id)).toBe(false);
    await query(
      "UPDATE bot_turns SET reply_to_bot_id=$2::uuid WHERE id=(SELECT turn_id FROM bot_messages WHERE id=$1::uuid)",
      [first.id, botId],
    );
  });

  test("checkpoint survives a gateway restart without replay; moves reset it", async () => {
    state = await open(a);
    const storage = { pg: a.pg, secretsKey: a.secretsKey, workerId: a.workerId, workerCredential: a.workerCredential };
    await a.close(true);
    a = await startTestGateway({ role: "desktop", storage });
    const delta = await open(a, botId, state.cursor);
    expect(delta.delta).toBe(true);
    expect(delta.messages).toHaveLength(0);
    expect(applyBotConversation(state, delta)).toEqual(await open(a));
    await query("UPDATE bots SET move_notes='{}'::jsonb WHERE id=$1::uuid", [botId]);
    expect((await open(a, botId, delta.cursor)).delta).toBe(false);
    state = await open(a);
  }, 30000);

  test("a linked bot and exchange pass the cursor to their home; legacy requests keep full state", async () => {
    b = await startTestGateway({ role: "desktop" });
    let legacyHome = false;

    const attach = (gw: TestGateway) => {
      const handlers = uiHandlers(gw.core);

      return linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        serve: remoteServe(
          {
            ...handlers,
            watchBotConversation: (request, context) =>
              handlers.watchBotConversation(
                legacyHome ? { ...request, incremental: false, cursor: "" } : request,
                context,
              ),
            readBotExchange: (request, context) =>
              handlers.readBotExchange(legacyHome ? { ...request, incremental: false, cursor: "" } : request, context),
          },
          gw.core,
        ),
      });
    };

    la = attach(a);
    lb = attach(b);
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    const pairing = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: pairing.code });
    await eventually(async () => lb!.reachable().includes(la!.hello().nodeId), Boolean, 15000);
    const remoteId = qualifyId(botId, la.hello().nodeId);
    const full = await open(b, remoteId);
    const delta = await open(b, remoteId, full.cursor);
    expect(delta.delta).toBe(true);
    expect(delta.messages).toHaveLength(0);
    expect(applyBotConversation(full, delta)).toEqual(full);
    expect((await open(b, remoteId, "", false)).messages).toHaveLength(999);
    const remoteExchange = qualifyId(exchangeId, la.hello().nodeId);
    const exchange = await b.api.readBotExchange({ exchangeId: remoteExchange, incremental: true });
    expect(exchange.messages).toHaveLength(999);

    const exchangeDelta = await b.api.readBotExchange({
      exchangeId: remoteExchange,
      incremental: true,
      cursor: exchange.cursor,
    });

    expect(exchangeDelta.delta).toBe(true);
    expect(exchangeDelta.messages).toHaveLength(0);
    // An older home ignores the additive request fields and returns the legacy full projection.
    legacyHome = true;
    const oldHome = await open(b, remoteId, delta.cursor);
    expect(oldHome.delta).toBe(false);
    expect(oldHome.cursor).toBe("");
    expect(applyBotConversation(full, oldHome).messages).toHaveLength(999);

    const oldExchange = await b.api.readBotExchange({
      exchangeId: remoteExchange,
      incremental: true,
      cursor: exchangeDelta.cursor,
    });

    expect(oldExchange.delta).toBe(false);
    expect(applyBotExchange(exchange, oldExchange).messages).toHaveLength(999);
  }, 60000);
});
