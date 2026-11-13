import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { BotsRuntime } from "../../apps/gateway/src/bots/runtime.ts";
import { eventually } from "./support/gateway.ts";
import { botsSuite } from "./support/bots.ts";

describe.skipIf(!dockerAvailable)("bot queue readiness and concurrent wakes", () => {
  const { suite, add } = botsSuite();
  const ids: string[] = [];
  const poll = (now = new Date()) => suite.current.bots.run((s) => s.poll(suite.gw.userId, now));
  // Client cursor reads do not lock the bot row against SKIP LOCKED claims.
  const read = (id: string) => suite.current.bots.run((s) => s.conversation(suite.gw.userId, id, ""));

  const query = (text: string, values: string[]) =>
    suite.gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(text, values)));

  async function source(name: string, args = {}) {
    const bot = await add(name);
    ids.push(bot.id);
    await suite.current.bots.run((s) => s.enqueue(suite.gw.userId, bot.id, "seed", crypto.randomUUID()));
    const turn = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;

    const call = await suite.current.bots.run((s) =>
      s.planCall(turn, "source", { name, description: name, source: "platform", parameters: {} }, args),
    );

    return { bot, turn, call };
  }

  beforeEach(async () => {
    await suite.current.bots.stop();
  });
  afterEach(async () => {
    await suite.current.bots.stop();

    for (const id of ids.splice(0)) await suite.current.bots.remove(id);
    suite.currentWorker.holdTurns = false;
  });

  test("a running watch stays idle until its target ends, then delivers exactly once", async () => {
    const { turn, call } = await source("Thread readiness");
    suite.currentWorker.holdTurns = true;

    const thread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        title: "Watched target",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    const target = (
      await suite.gw.api.sendMessage({ threadId: thread.id, text: "hold", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await suite.current.bots.run((s) => s.watchThread(turn, call, thread.id, target.id));
    await suite.current.bots.run((s) => s.finish(turn, "completed", "watching"));
    expect((await poll()).ready).toBe(false);
    expect(await eventually(async () => suite.currentWorker.inputs.has(thread.id), Boolean)).toBe(true);
    suite.currentWorker.finish(thread.id, target.id, "Watched result");
    expect(await eventually(async () => (await poll()).ready, Boolean)).toBe(true);
    expect((await poll()).ready).toBe(true);
    await suite.current.bots.run((s) => s.deliver());
    await suite.current.bots.run((s) => s.deliver());
    expect(await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [`thread:${call.id}`])).toHaveLength(1);
  });

  test("future, cancelled and delivered wakeups stay idle; a due wakeup delivers once", async () => {
    const { turn, call } = await source("Wakeup readiness", {
      run_at: new Date(Date.now() + 60_000).toISOString(),
      prompt: "Wake up",
    });

    await suite.current.bots.run((s) => s.wakeup(turn, call));
    await suite.current.bots.run((s) => s.finish(turn, "completed", "scheduled"));
    expect((await poll()).ready).toBe(false);
    await query("UPDATE bot_wakeups SET run_at=now()-interval '1 second',cancelled=true WHERE id=$1::uuid", [call.id]);
    expect((await poll()).ready).toBe(false);
    await query("UPDATE bot_wakeups SET cancelled=false,delivered=true WHERE id=$1::uuid", [call.id]);
    expect((await poll()).ready).toBe(false);
    await query("UPDATE bot_wakeups SET delivered=false WHERE id=$1::uuid", [call.id]);
    expect((await poll()).ready).toBe(true);
    await suite.current.bots.run((s) => s.deliver());
    await suite.current.bots.run((s) => s.deliver());
    expect(await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [`wakeup:${call.id}`])).toHaveLength(1);
  });

  test("routine readiness honors the scheduler clock, enablement, deletion and owner", async () => {
    const { turn } = await source("Routine readiness");
    const now = new Date();

    const routine = await suite.current.bots.run((s) =>
      s.createRoutine(
        suite.gw.userId,
        turn,
        crypto.randomUUID(),
        {
          title: "Periodic check",
          instructions: "Check quietly",
          cron: "*/15 * * * *",
          timezone: "UTC",
        },
        now,
      ),
    );

    await suite.current.bots.run((s) => s.finish(turn, "completed", "scheduled"));
    const due = new Date(now.getTime() + 16 * 60_000);
    expect((await poll(now)).ready).toBe(false);
    expect((await poll(due)).ready).toBe(true);
    expect(await suite.current.bots.run((s) => s.poll(crypto.randomUUID(), due))).toEqual({
      configured: false,
      ready: false,
    });
    await query("UPDATE bot_routines SET enabled=false WHERE id=$1::uuid", [routine.id]);
    expect((await poll(due)).ready).toBe(false);
    await query("UPDATE bot_routines SET enabled=true,deleted_at=now() WHERE id=$1::uuid", [routine.id]);
    expect((await poll(due)).ready).toBe(false);
    await query("UPDATE bot_routines SET deleted_at=NULL WHERE id=$1::uuid", [routine.id]);
    await suite.current.bots.run((s) => s.deliverRoutines(suite.gw.userId, due));
    await suite.current.bots.run((s) => s.deliverRoutines(suite.gw.userId, due));
    expect(await query("SELECT id FROM bot_turns WHERE routine_id=$1::uuid", [routine.id])).toHaveLength(1);
  });

  test("queued work behind a waiting or live running turn is idle until the barrier clears", async () => {
    const { bot, turn } = await source("Waiting readiness");
    await query("UPDATE bot_turns SET status='waiting',lease_until=NULL WHERE id=$1::uuid", [turn.id]);
    await suite.current.bots.run((s) => s.enqueue(suite.gw.userId, bot.id, "next", crypto.randomUUID()));
    expect((await poll()).ready).toBe(false);
    await query("UPDATE bot_turns SET status='running',lease_until=now()+interval '30 seconds' WHERE id=$1::uuid", [
      turn.id,
    ]);
    expect((await poll()).ready).toBe(false);
    await query("UPDATE bot_turns SET status='completed',lease_until=NULL WHERE id=$1::uuid", [turn.id]);
    expect((await poll()).ready).toBe(true);
  });

  test("a send during an idle preflight replays the wake without a timer", async () => {
    const bot = await add("Concurrent wake");
    ids.push(bot.id);
    const store = await suite.gw.runtime.runPromise(BotStore);
    const original = store.poll;
    const sampled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;

    const delayed = spyOn(store, "poll").mockImplementation((owner, now) =>
      original(owner, now).pipe(
        Effect.flatMap((state) =>
          Effect.promise(async () => {
            if (!held) {
              held = true;
              sampled.resolve();
              await release.promise;
            }

            return state;
          }),
        ),
      ),
    );

    const queue = new BotsRuntime({
      runtime: suite.gw.runtime,
      userId: suite.gw.userId,
      connectors: suite.current.connectors,
      model: (input) => suite.model(input),
      platform: async () => ({}),
    });

    // No polling timer can rescue a lost wake.
    const ticking = queue.tick();

    try {
      await sampled.promise;
      await queue.send(
        create(bots.SendBotMessageRequestSchema, {
          botId: bot.id,
          text: "Replay this wake",
          clientRequestId: crypto.randomUUID(),
        }),
      );
      release.resolve();
      await ticking;

      const result = await eventually(
        () => read(bot.id),
        (view) => view.messages.at(-1)?.text === "Reply: Replay this wake",
        5000,
      );

      expect(result.messages.at(-1)?.text).toBe("Reply: Replay this wake");
      expect(result.messages.filter((message) => message.text === "Reply: Replay this wake")).toHaveLength(1);
    } finally {
      release.resolve();
      await ticking;
      await queue.stop();
      delayed.mockRestore();
    }
  }, 10_000);

  test("configured owners keep a 250 ms cadence when each preflight takes 30 ms", async () => {
    const bot = await add("Queue cadence");
    ids.push(bot.id);
    const store = await suite.gw.runtime.runPromise(BotStore);
    const original = store.poll;
    const samples: number[] = [];

    const delayed = spyOn(store, "poll").mockImplementation((owner, now) =>
      original(owner, now).pipe(
        Effect.flatMap((state) =>
          Effect.promise(async () => {
            await Bun.sleep(30);
            samples.push(performance.now());

            return state;
          }),
        ),
      ),
    );

    try {
      suite.current.bots.start();
      await eventually(
        async () => samples.length,
        (count) => count >= 5,
        2500,
      );
      expect(samples.length).toBeGreaterThanOrEqual(5);
      expect(samples[4]! - samples[0]!).toBeLessThan(1500);
    } finally {
      await suite.current.bots.stop();
      delayed.mockRestore();
    }
  });
});
