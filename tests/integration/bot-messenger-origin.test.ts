import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import { conversationFiles } from "../../apps/gateway/src/core/bot-files.ts";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { botsSuite } from "./support/bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("messenger work callback origin", () => {
  const { suite, add, read } = botsSuite();
  const ids: string[] = [];

  const query = <A extends object>(text: string, values: string[] = []) =>
    suite.gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, values)));

  const messenger = <A, E>(use: (s: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    suite.gw.runtime.runPromise(MessengerStore.use(use));

  beforeEach(async () => {
    await suite.current.bots.stop();
    suite.currentWorker.holdTurns = true;
  });
  afterEach(async () => {
    suite.currentWorker.holdTurns = false;

    for (const id of ids.splice(0)) await suite.current.bots.remove(id);
  });

  async function external(existing?: string) {
    const botId = existing ?? (await add("Messenger origin")).id;
    ids.push(botId);

    const account = await messenger((s) =>
      s.saveAccount(suite.gw.userId, {
        name: "Origin workspace",
        externalId: crypto.randomUUID(),
        appToken: "xapp-fixture",
        botToken: "xoxb-fixture",
      }),
    );

    const route = await messenger((s) =>
      s.saveRoute(suite.gw.userId, {
        botId,
        accountId: account.id,
        channelIds: ["CPRODUCT"],
        userIds: ["UREPORTER"],
        directMessages: false,
        mentions: true,
        observe: false,
        delivery: "reply",
        instructions: "Investigate reported issues.",
      }),
    );

    const now = new Date();
    const lease = (await messenger((s) => s.claimAccount(suite.gw.userId, account.id, "origin-test", now)))!;
    await messenger((s) =>
      s.ingest(
        suite.gw.userId,
        {
          id: crypto.randomUUID(),
          accountId: account.id,
          channelId: "CPRODUCT",
          threadId: "100.1",
          messageId: "100.2",
          authorId: "UREPORTER",
          text: "Investigate the login issue",
          timestamp: "100.2",
          mention: true,
          direct: false,
        },
        lease,
        now,
      ),
    );
    await messenger((s) => s.dispatch(suite.gw.userId, new Date(now.getTime() + 3000)));
    const turn = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;

    expect(turn.conversation_id).toBeTruthy();

    return { botId, turn, route, lease };
  }

  async function delegated(turn: BotTurn) {
    const thread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        title: "Login fix",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    const target = (
      await suite.gw.api.sendMessage({
        threadId: thread.id,
        text: "Investigate login",
        clientRequestId: crypto.randomUUID(),
      })
    ).turn!;

    const call = await suite.current.bots.run((s) =>
      s.planCall(
        turn,
        "delegate",
        {
          name: "start_thread",
          description: "Delegate a repair",
          source: "platform",
          parameters: {},
        },
        {},
      ),
    );

    await suite.current.bots.run((s) => s.watchThread(turn, call, thread.id, target.id));
    await suite.current.bots.run((s) => s.finish(turn, "completed", "Investigating"));
    expect(await eventually(async () => suite.currentWorker.inputs.has(thread.id), Boolean)).toBe(true);

    return { thread, target, call };
  }

  async function finishTarget(threadId: string, turnId: string) {
    suite.currentWorker.finish(threadId, turnId, "Login repair is ready");
    expect(
      await eventually(
        () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turnId]),
        (r) => r[0]?.status === "completed",
      ),
    ).toEqual([{ status: "completed" }]);
  }

  test("a delegated thread reports once into the originating external conversation", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    await finishTarget(work.thread.id, work.target.id);
    await suite.current.bots.run((s) => s.deliver());
    await suite.current.bots.run((s) => s.deliver());

    const callbacks = await query<BotTurn>("SELECT * FROM bot_turns WHERE client_request_id=$1", [
      `thread:${work.call.id}`,
    ]);

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]!.conversation_id).toBe(f.turn.conversation_id);
    expect(callbacks[0]!.input).toContain("Login repair is ready");
    const followup = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;
    await suite.current.bots.run((s) => s.finish(followup, "completed", "The repair is ready for review"));
    const outbound = await messenger((s) => s.outbound(suite.gw.userId, f.lease, new Date()));

    expect(outbound.map((o) => o.threadId)).toEqual(["100.1", "100.1"]);
    expect((await read(f.botId)).messages).toHaveLength(0);
  });

  test("revoking a subscription suppresses later thread reports without falling into private chat", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    await messenger((s) => s.deleteRoute(suite.gw.userId, f.route.id));
    await finishTarget(work.thread.id, work.target.id);
    await suite.current.bots.run((s) => s.deliver());

    expect(await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [`thread:${work.call.id}`])).toEqual([]);
    expect((await read(f.botId)).messages).toHaveLength(0);
    expect(await suite.current.bots.run((s) => s.originEnabled(f.turn))).toBe(false);
  });

  test("external thread tools cannot forward guessed private conversation attachment ids", async () => {
    const botId = (await add("Private attachment origin")).id;

    const file = (
      await suite.gw.api.uploadAttachment({
        botId,
        name: "private.md",
        data: new TextEncoder().encode("Private conversation material"),
      })
    ).attachment!;

    await suite.current.bots.run((s) =>
      s.enqueue(suite.gw.userId, botId, "Keep this private", crypto.randomUUID(), {
        attachmentIds: [file.id],
      }),
    );
    const privateTurn = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;
    await suite.current.bots.run((s) => s.finish(privateTurn, "completed", "Saved"));
    const f = await external(botId);

    expect(await conversationFiles(suite.current, f.turn)).toEqual([]);
    await expect(conversationFiles(suite.current, f.turn, [file.id])).rejects.toThrow("A file is unavailable");
    expect((await conversationFiles(suite.current, privateTurn, [file.id]))[0]?.id).toBe(file.id);
    await suite.current.bots.run((s) => s.finish(f.turn, "completed", "No private attachment"));
  });
});
