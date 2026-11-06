import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { applyBotConversation } from "@canopy/domain/bot-snapshot";
import { prependThreadPage, prependBotPage } from "@canopy/domain/history-pages";
import { qualifyId } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("tail pages and journal checkpoints on real gateways", () => {
  let gateway: TestGateway;
  let partner: TestGateway | undefined;
  let homeLink: LinkedComputers | undefined;
  let partnerLink: LinkedComputers | undefined;
  let thread: string;
  let bot: string;
  let exchange: string;
  const query = (sql: string, params: unknown[] = []) => gateway.core.linkedAgents.query(sql, params);

  async function openThread(input: MessageInitShape<typeof ui.WatchThreadRequestSchema> = {}, server = gateway) {
    const abort = new AbortController();

    try {
      for await (const update of server.api.watchThread(
        { threadId: thread, incremental: true, pageSize: 12, ...input },
        { signal: abort.signal, timeoutMs: 5000 },
      ))
        return update;
      throw new Error("Missing initial thread state");
    } finally {
      abort.abort();
    }
  }

  async function openBot(
    input: MessageInitShape<typeof bots.WatchBotConversationRequestSchema> = {},
    server = gateway,
  ) {
    const abort = new AbortController();

    try {
      for await (const update of server.api.watchBotConversation(
        { botId: bot, incremental: true, pageSize: 12, ...input },
        { signal: abort.signal, timeoutMs: 5000 },
      ))
        return update;
      throw new Error("Missing initial bot state");
    } finally {
      abort.abort();
    }
  }

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop" });
    const project = (await gateway.api.createProject({ name: "Paged history" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/pages" })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
    await query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq,completed_at)
      SELECT gen_random_uuid(),$1::uuid,n,'completed','user',$2::uuid,jsonb_build_object('text','Question '||n),n*2-1,n*2,now()
      FROM generate_series(1,80) n`,
      [thread, gateway.userId],
    );
    await query(
      `INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      SELECT thread_id,'answer-'||ordinal,id,'agent_message','completed',
        jsonb_build_object('itemId','answer-'||ordinal,'status','ITEM_STATUS_COMPLETED','agentMessage',jsonb_build_object('text',repeat('output ',100),'phase','final_answer')),ordinal*2,ordinal*2
      FROM turns WHERE thread_id=$1::uuid`,
      [thread],
    );
    await query("UPDATE threads SET last_seq=160 WHERE id=$1::uuid", [thread]);
    bot = (
      await gateway.api.createBot({
        configuration: {
          name: "Paged bot",
          shape: "round",
          color: "#2288aa",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
        },
        clientRequestId: crypto.randomUUID(),
      })
    ).bot!.id;
    exchange = crypto.randomUUID();
    await query(
      `INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,reply_to_bot_id,exchange_id)
      SELECT gen_random_uuid(),$1::uuid,'page-'||n,'Question','completed',$1::uuid,$2::uuid FROM generate_series(1,80) n`,
      [bot, exchange],
    );
    await query(
      `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text,exchange_id)
      SELECT gen_random_uuid(),bot_id,id,'answer',bot_id::text,'user',repeat('output ',100),exchange_id FROM bot_turns WHERE bot_id=$1::uuid`,
      [bot],
    );
  }, 60000);

  afterAll(async () => {
    await homeLink?.close();
    await partnerLink?.close();
    await partner?.close();
    await gateway?.close();
  });

  test("thread pages cover complete turns without omissions while new turns arrive", async () => {
    let state = applyThreadUpdate(undefined, await openThread());
    expect(state.turns).toHaveLength(12);
    expect(state.items).toHaveLength(12);
    expect(state.turns[0]!.ordinal).toBe(69);
    const coldBytes = toBinary(ui.ThreadSnapshotSchema, state).length;
    await query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq,completed_at)
      VALUES(gen_random_uuid(),$1::uuid,81,'completed','user',$2::uuid,'{}',161,162,now())`,
      [thread, gateway.userId],
    );
    const delta = await openThread({ cursor: state.cursor });
    expect(delta.change.case).toBe("delta");
    state = applyThreadUpdate(state, delta);
    expect(state.turns.at(-1)?.ordinal).toBe(81);

    while (state.historyHasMore) {
      const page = applyThreadUpdate(
        undefined,
        await openThread({ beforeTurnId: state.historyBeforeTurnId, historyVersion: state.historyVersion }),
      );

      state = prependThreadPage(state, page);
    }

    const full = applyThreadUpdate(undefined, await openThread({ pageSize: 0 }));
    expect(state.turns).toEqual(full.turns);
    expect(state.items).toEqual(full.items);
    expect(coldBytes).toBeLessThan(toBinary(ui.ThreadSnapshotSchema, full).length / 4);
    const targeted = applyThreadUpdate(undefined, await openThread({ targetItemId: "answer-2" }));
    expect(targeted.items[0]?.item?.itemId).toBe("answer-2");
  });

  test("fork pages include inherited history, and changed history resets an older-page request", async () => {
    const source = (await gateway.api.getThread({ threadId: thread })).thread!;

    const fork = (
      await gateway.api.createThread({
        projectId: source.projectId,
        workspaceId: source.workspaceId,
        parentThreadId: thread,
        fork: true,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    let state = applyThreadUpdate(undefined, await openThread({ threadId: fork.id }));
    expect(state.turns.every((turn) => turn.inherited)).toBe(true);

    while (state.historyHasMore)
      state = prependThreadPage(
        state,
        applyThreadUpdate(
          undefined,
          await openThread({
            threadId: fork.id,
            beforeTurnId: state.historyBeforeTurnId,
            historyVersion: state.historyVersion,
          }),
        ),
      );
    expect(state.turns).toHaveLength(81);

    const reset = applyThreadUpdate(
      undefined,
      await openThread({ beforeTurnId: state.historyBeforeTurnId, historyVersion: "other-history" }),
    );

    expect(reset.historyReset).toBe(true);
    expect(reset.turns).toHaveLength(12);
    const foreign = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      foreign,
      `${foreign}@example.test`,
    ]);
    const foreignThread = crypto.randomUUID();
    await query(
      `INSERT INTO threads(id,root_thread_id,owner_user_id,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status)
      SELECT $1::uuid,$1::uuid,$2::uuid,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status FROM threads WHERE id=$3::uuid`,
      [foreignThread, foreign, thread],
    );
    await expect(openThread({ threadId: foreignThread, beforeTurnId: state.historyBeforeTurnId })).rejects.toThrow();
  });

  test("bot and exchange pages remain stable under edits and new messages; gaps fall back to a tail", async () => {
    let state = await openBot();
    expect(state.messages).toHaveLength(12);
    const latest = state.messages.at(-1)!;
    const page = await openBot({ beforeSeq: state.historyBeforeSeq, cursor: state.cursor });
    await query("UPDATE bot_messages SET text='newer edit' WHERE id=$1::uuid", [latest.id]);
    state = applyBotConversation(state, await openBot({ cursor: state.cursor }));
    state = prependBotPage(state, page);
    expect(state.messages.at(-1)?.text).toBe("newer edit");

    while (state.historyHasMore)
      state = prependBotPage(state, await openBot({ beforeSeq: state.historyBeforeSeq, cursor: state.cursor }));
    expect(state.messages).toEqual((await openBot({ pageSize: 0 })).messages);
    let view = await gateway.api.readBotExchange({ exchangeId: exchange, incremental: true, pageSize: 12 });
    expect(view.messages).toHaveLength(12);

    while (view.historyHasMore)
      view = prependBotPage(
        view,
        await gateway.api.readBotExchange({
          exchangeId: exchange,
          incremental: true,
          pageSize: 12,
          beforeSeq: view.historyBeforeSeq,
          cursor: view.cursor,
        }),
      );
    expect(view.messages).toHaveLength(80);
    const reset = await openBot({ beforeSeq: latest.seq, cursor: "unknown" });
    expect(reset.historyReset).toBe(true);
    expect(reset.messages).toHaveLength(12);
    await expect(
      gateway.core.bots.run((s) => s.conversation(crypto.randomUUID(), bot, state.cursor, 12, latest.seq)),
    ).rejects.toThrow();
    const legacy = await openBot({ incremental: false, pageSize: 0 });
    expect(legacy.messages).toHaveLength(80);
  });

  test("growing a window replays edits made while its older page was in flight", async () => {
    let state = await openBot();
    const checkpoint = state.cursor;
    const page = await openBot({ beforeSeq: state.historyBeforeSeq, cursor: checkpoint });
    const older = page.messages[0]!;
    await query("UPDATE bot_messages SET text='edited during paging' WHERE id=$1::uuid", [older.id]);
    state = applyBotConversation(state, await openBot({ cursor: checkpoint }));
    expect(state.messages.some((m) => m.id === older.id)).toBe(false);
    state = prependBotPage(state, page, checkpoint);
    expect(state.messages.find((m) => m.id === older.id)?.text).not.toBe("edited during paging");
    state = applyBotConversation(state, await openBot({ cursor: state.cursor }));
    expect(state.messages.find((m) => m.id === older.id)?.text).toBe("edited during paging");
  });

  test("loaded tails resume after a gateway restart without downloading history", async () => {
    const threadState = applyThreadUpdate(undefined, await openThread());
    const botState = await openBot();

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ role: "desktop", storage });
    const delta = await openThread({ cursor: threadState.cursor });
    expect(delta.change.case).toBe("delta");
    expect(applyThreadUpdate(threadState, delta).turns).toEqual(threadState.turns);
    const botDelta = await openBot({ cursor: botState.cursor });
    expect(botDelta.delta).toBe(true);
    expect(botDelta.messages).toHaveLength(0);
    expect(applyBotConversation(botState, botDelta).messages).toEqual(botState.messages);
    const fallback = applyThreadUpdate(undefined, await openThread({ cursor: "unknown" }));
    expect(fallback.turns).toHaveLength(12);
  }, 30000);

  test("linked threads and bots pass paging and durable cursors through to their home", async () => {
    partner = await startTestGateway({ role: "desktop" });

    const attach = (server: TestGateway) =>
      linkedComputers({
        store: new ComputerStore(server.runtime, server.userId, server.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        serve: remoteServe(uiHandlers(server.core), server.core),
      });

    homeLink = attach(gateway);
    partnerLink = attach(partner);
    gateway.core.computers = homeLink;
    gateway.core.network = homeLink.options.network;
    partner.core.computers = partnerLink;
    partner.core.network = partnerLink.options.network;
    await homeLink.start();
    await partnerLink.start();
    const pairing = await gateway.api.createComputerPairing({});
    await partner.api.linkComputer({ address: homeLink.addresses[0]!, code: pairing.code });
    await eventually(async () => partnerLink!.reachable().includes(homeLink!.hello().nodeId), Boolean, 15000);
    const remoteThread = qualifyId(thread, homeLink.hello().nodeId);
    const state = applyThreadUpdate(undefined, await openThread({ threadId: remoteThread }, partner));
    expect(state.turns).toHaveLength(12);

    const page = applyThreadUpdate(
      undefined,
      await openThread(
        { threadId: remoteThread, beforeTurnId: state.historyBeforeTurnId, historyVersion: state.historyVersion },
        partner,
      ),
    );

    expect(prependThreadPage(state, page).turns).toHaveLength(24);
    expect((await openThread({ threadId: remoteThread, cursor: state.cursor }, partner)).change.case).toBe("delta");
    const remoteBot = qualifyId(bot, homeLink.hello().nodeId);
    const chat = await openBot({ botId: remoteBot }, partner);
    expect(chat.messages).toHaveLength(12);
    expect((await openBot({ botId: remoteBot, cursor: chat.cursor }, partner)).messages).toHaveLength(0);
    await eventually(
      () => partnerLink!.mirror.read(homeLink!.hello().nodeId, thread),
      (held) => !!held?.snapshot.thread,
      15000,
    );
    await homeLink.close();
    await eventually(
      async () => partnerLink!.reachable().includes(homeLink!.hello().nodeId),
      (online) => !online,
      15000,
    );
    const offline = await openThread({ threadId: remoteThread }, partner);
    expect(offline.syncing).toBe(true);
    const tail = applyThreadUpdate(undefined, offline);
    expect(tail.turns).toHaveLength(12);

    const older = applyThreadUpdate(
      undefined,
      await openThread(
        { threadId: remoteThread, beforeTurnId: tail.historyBeforeTurnId, historyVersion: tail.historyVersion },
        partner,
      ),
    );

    const grown = prependThreadPage(tail, older);
    expect(grown.turns).toHaveLength(24);
    const resumed = await openThread({ threadId: remoteThread, cursor: grown.cursor }, partner);
    expect(resumed.change.case).toBe("delta");
    expect(applyThreadUpdate(grown, resumed).turns).toEqual(grown.turns);
  }, 30000);
});
