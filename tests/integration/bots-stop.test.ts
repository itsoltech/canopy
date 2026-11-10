import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, ThreadEventSchema, TurnOutcome } from "@canopy/contracts";
import { Provider } from "@canopy/contracts";
import { GatewayCore } from "@canopy/gateway/core";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";
import { eventually, failure } from "./support/gateway.ts";

describe("stop a bot reply through the worker harness", () => {
  let f: InstanceFixture;
  let closeReconnect = async () => {};
  const read = (id: string) => f.gw.core.bots.run((s) => s.conversation(f.gw.userId, id));

  const send = (id: string, text: string) =>
    f.gw.api.sendBotMessage({ botId: id, text, clientRequestId: crypto.randomUUID() });

  const add = async (provider: Provider) =>
    (
      await f.gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: `Stop ${crypto.randomUUID().slice(0, 8)}`,
          shape: "round",
          color: "#22aaff",
          provider,
          providerInstance: "native",
          workerId: f.workerId,
          model: "fixture-model",
          approvalPolicy: "safe",
        },
      })
    ).bot!;

  const settled = (id: string) =>
    eventually(
      () => read(id),
      (r) => !r.working,
      10_000,
    );

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  };

  const started = async (botId: string) => {
    const view = await eventually(
      () => read(botId),
      (r) => r.streamingText === "Partial reply",
      10_000,
    );

    expect(view.streamingText).toBe("Partial reply");
    const turn = f.records().findLast((r) => r.event === "turn" && r.home.includes(`/bots/${botId}/`));
    expect(turn).toBeDefined();

    return turn!;
  };

  beforeAll(async () => {
    f = await startInstanceFixture(true);

    for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      await f.save(provider, "bot-stop");
      await f.gw.api.setInstanceModels({ harness: provider, id: "native", models: { custom: ["fixture-model"] } });
    }

    f.gw.core.bots.start();
  }, 30_000);
  afterAll(async () => {
    await closeReconnect();
    await f?.close();
  });

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} retains partial output, kills the harness and accepts the next message`, async () => {
      const bot = await add(provider);
      const turn = await send(bot.id, `STOP_REPLY HOLD:stop-${provider}`);
      const process = await started(bot.id);
      await f.gw.api.interruptBot({ botId: bot.id });
      const stopped = await read(bot.id);
      expect(stopped.working).toBe(false);
      expect(stopped.streamingText).toBe("");
      expect(stopped.messages.slice(-2).map((m) => m.text)).toEqual(["Partial reply", "Stopped by you"]);
      expect((await f.gw.core.bots.run((s) => s.harnessTurn(turn.turnId)))?.outcome).toBe(TurnOutcome.INTERRUPTED);

      // Send immediately, before waiting for the old process to exit. A stale BUSY must never fail this reply.
      await send(bot.id, "Next message");
      const result = await settled(bot.id);
      expect(result.working).toBe(false);
      expect(result.messages.at(-1)?.text).toBe("FIXTURE_OK");
      expect(
        await eventually(
          async () => alive(process.pid),
          (running) => !running,
        ),
      ).toBe(false);
      await f.release(`stop-${provider}`);
      expect(f.records().some((r) => r.pid === process.pid && r.event === "finish")).toBe(false);

      // Even a replaying/misbehaving worker cannot replace the saved partial or terminal outcome.
      const journal = `late-${crypto.randomUUID()}`;

      for (const body of [
        { case: "itemDelta" as const, value: { itemId: "late", field: ItemDeltaField.TEXT, chunk: "Late reply" } },
        { case: "turnFinished" as const, value: { outcome: TurnOutcome.COMPLETED } },
      ])
        await f.gw.core.bots.run((s) =>
          s.harnessEvent(
            f.workerId,
            journal,
            create(ThreadEventSchema, {
              eventId: crypto.randomUUID(),
              threadId: bot.id,
              turnId: turn.turnId,
              journalSeq: 1n,
              body,
            }),
          ),
        );
      expect((await read(bot.id)).messages.map((m) => m.text)).toEqual(result.messages.map((m) => m.text));
      expect((await f.gw.core.bots.run((s) => s.harnessTurn(turn.turnId)))?.text).toBe("Partial reply");
    }, 20_000);
  }

  test("offline Stop survives gateway restart and fences replay before the next reply", async () => {
    const bot = await add(Provider.GROK);
    const turn = await send(bot.id, "STOP_REPLY HOLD:offline-stop");
    const process = await started(bot.id);
    await f.disconnect();
    await f.gw.api.interruptBot({ botId: bot.id });
    expect((await read(bot.id)).working).toBe(false);
    expect(alive(process.pid)).toBe(true);
    await f.restartGateway();
    f.gw.core.bots.start();
    closeReconnect = await f.reconnect();
    await send(bot.id, "After reconnect");
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect(alive(process.pid)).toBe(false);
    expect((await f.gw.core.bots.run((s) => s.harnessTurn(turn.turnId)))?.outcome).toBe(TurnOutcome.INTERRUPTED);
    expect((await read(bot.id)).messages.filter((m) => m.text === "Stopped by you")).toHaveLength(1);
  }, 25_000);

  test("Stop affects only the current reply and cannot be requested by another owner", async () => {
    const bot = await add(Provider.CODEX);
    await send(bot.id, "STOP_REPLY HOLD:owner-stop");
    await started(bot.id);
    await send(bot.id, "Already queued");

    const foreign = new GatewayCore({
      runtime: f.gw.runtime,
      userId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
    });

    expect(await failure(foreign.bots.interrupt(bot.id))).not.toBe("");
    expect((await read(bot.id)).streamingText).toBe("Partial reply");
    await f.gw.api.interruptBot({ botId: bot.id });
    const result = await settled(bot.id);
    expect(result.messages.map((m) => m.text)).toEqual([
      "STOP_REPLY HOLD:owner-stop",
      "Already queued",
      "Partial reply",
      "Stopped by you",
      "FIXTURE_OK",
    ]);
  }, 20_000);

  test("offline Stop remains terminal after the worker restarts", async () => {
    const bot = await add(Provider.CLAUDE);
    const turn = await send(bot.id, "STOP_REPLY HOLD:worker-restart-stop");
    const process = await started(bot.id);
    await f.disconnect();
    await f.gw.api.interruptBot({ botId: bot.id });
    await f.restartWorker();
    await send(bot.id, "After worker restart");
    const result = await settled(bot.id);
    expect(result.working).toBe(false);
    expect(result.messages.slice(-4).map((m) => m.text)).toEqual([
      "Partial reply",
      "Stopped by you",
      "After worker restart",
      "FIXTURE_OK",
    ]);
    expect(alive(process.pid)).toBe(false);
    expect((await f.gw.core.bots.run((s) => s.harnessTurn(turn.turnId)))?.outcome).toBe(TurnOutcome.INTERRUPTED);
  }, 25_000);
});
