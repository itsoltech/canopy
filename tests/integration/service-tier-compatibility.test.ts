import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SERVICE_TIERS_CAPABILITY } from "@canopy/domain/release/protocol";
import { eventually, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const legacyCapabilities = ["bot_harness_v1", "bot_web_v1", "bot_workspace_v1"];

const models = [
  {
    provider: Provider.CODEX,
    profileId: "native",
    models: [{ id: "fixture-model", isDefault: true, serviceTiers: [{ id: "fast", name: "Fast" }] }],
  },
];

describe.skipIf(!dockerAvailable)("speed capability with mixed worker versions", () => {
  let gw: TestGateway;
  let legacy: ScriptedWorker;
  let modern: ScriptedWorker;
  let modernId: string;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: legacyCapabilities }, models } });
    legacy = gw.worker;
    await gw.api.renameWorker({ workerId: gw.workerId, name: "A legacy" });
    const added = await gw.addWorker("Z modern");
    modernId = added.workerId;
    modern = await gw.connect(added.workerId, added.credential, undefined, {
      hello: { capabilities: [...legacyCapabilities, SERVICE_TIERS_CAPABILITY] },
      models,
    });
    await gw.api.setInstanceWorkers({ harness: Provider.CODEX, id: "native", allWorkers: true });
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.filter((w) => w.appliedVersion > 0n).length === 2,
    );
    await gw.api.listModels({ refresh: true });
    projectId = (await gw.api.createProject({ name: "Speed compatibility" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/speed" }))
      .workspace!.id;
    gw.core.bots.start();
  }, 60_000);

  afterAll(async () => gw?.close());

  const addBot = async (serviceTier: string, workerId = "") =>
    (
      await gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: `Speed ${crypto.randomUUID()}`,
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "fixture-model",
          serviceTier,
          workerId,
        },
      })
    ).bot!;

  const sendBot = async (botId: string) =>
    gw.api.sendBotMessage({ botId, text: "Continue", clientRequestId: crypto.randomUUID() });

  const readBot = (botId: string) => gw.core.bots.run((s) => s.conversation(gw.userId, botId));

  const reconnectLegacy = async () => {
    legacy = await gw.connect(gw.workerId, gw.workerCredential, undefined, {
      hello: { capabilities: legacyCapabilities },
      models,
    });
  };

  const threadTurns = (threadId: string) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{ id: string; status: string; error_code: string | null }>`
          SELECT id,status,error_code FROM turns WHERE thread_id=${threadId}::uuid ORDER BY ordinal`;
      }),
    );

  const createThread = async () =>
    (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, model: "fixture-model" })).thread!;

  for (const serviceTier of ["fast", "default"]) {
    test(`automatic bot placement requires support for explicit ${serviceTier}`, async () => {
      const bot = await addBot(serviceTier);
      await sendBot(bot.id);

      try {
        await eventually(
          async () => modern.commands.filter((c) => c.case === "runBotTurn" && c.value.botId === bot.id),
          (commands) => commands.length === 1,
        );
        expect((await gw.api.getBot({ botId: bot.id })).bot?.configuration?.workerId).toBe(modernId);
        expect(legacy.commands.some((c) => c.case === "runBotTurn" && c.value.botId === bot.id)).toBe(false);
      } finally {
        await gw.api.interruptBot({ botId: bot.id });
      }
    });

    test(`a pinned older worker refuses explicit ${serviceTier} before persisting a bot command`, async () => {
      const bot = await addBot(serviceTier, gw.workerId);
      const { turnId } = await sendBot(bot.id);

      const result = await eventually(
        () => readBot(bot.id),
        (r) => !r.working,
      );

      expect(result.messages.at(-1)).toMatchObject({
        failed: true,
        errorCode: "configuration",
        errorSource: "platform",
      });
      expect(await gw.core.bots.run((s) => s.harnessTurn(turnId))).toBeUndefined();
      expect(legacy.commands.some((c) => c.case === "runBotTurn" && c.value.botId === bot.id)).toBe(false);
    });

    test(`a persisted bot command with ${serviceTier} is refused on reconnect to an older worker`, async () => {
      const bot = await addBot(serviceTier, gw.workerId);
      legacy.link.close();
      await eventually(
        () => gw.api.getOverview({}),
        (o) => !o.workers.find((w) => w.id === gw.workerId)?.online,
      );
      const { turnId } = await sendBot(bot.id);
      await eventually(() => gw.core.bots.run((s) => s.harnessTurn(turnId)), Boolean);
      await reconnectLegacy();

      const result = await eventually(
        () => readBot(bot.id),
        (r) => !r.working,
      );

      expect(result.messages.at(-1)).toMatchObject({
        failed: true,
        errorCode: "configuration",
        errorSource: "platform",
      });
      expect(await gw.core.bots.run((s) => s.harnessCommandFailure(turnId))).toMatchObject({
        errorCode: "SERVICE_TIERS_UNSUPPORTED",
      });
      expect(legacy.commands.some((c) => c.case === "runBotTurn" && c.value.botId === bot.id)).toBe(false);
    });

    test(`a persisted thread start with ${serviceTier} is refused on reconnect to an older worker`, async () => {
      const thread = await createThread();
      await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (r) => r.thread?.status === "idle",
      );
      legacy.link.close();
      await eventually(
        () => gw.api.getOverview({}),
        (o) => !o.workers.find((w) => w.id === gw.workerId)?.online,
      );
      await gw.api.sendMessage({
        threadId: thread.id,
        text: "Continue",
        serviceTier,
        clientRequestId: crypto.randomUUID(),
      });
      await reconnectLegacy();

      const result = await eventually(
        () => threadTurns(thread.id),
        (r) => r[0]?.status === "failed",
      );

      expect(result[0]?.error_code).toBe("SERVICE_TIERS_UNSUPPORTED");
      expect(legacy.commands.some((c) => c.case === "startTurn" && c.value.thread?.threadId === thread.id)).toBe(false);
    });
  }

  test("an explicit Standard steer falls back without reaching the older worker", async () => {
    const thread = await createThread();
    legacy.holdTurns = true;
    await gw.api.sendMessage({ threadId: thread.id, text: "Run", clientRequestId: crypto.randomUUID() });

    const running = await eventually(
      () => threadTurns(thread.id),
      (r) => r[0]?.status === "running",
    );

    try {
      await gw.api.sendMessage({
        threadId: thread.id,
        text: "Standard",
        serviceTier: "default",
        delivery: ui.MessageDelivery.STEER,
        clientRequestId: crypto.randomUUID(),
      });
      await eventually(
        () => threadTurns(thread.id),
        (r) => r.length === 2,
      );
      expect(legacy.commands.some((c) => c.case === "steerTurn" && c.value.threadId === thread.id)).toBe(false);
      legacy.finish(thread.id, running[0]!.id);

      const result = await eventually(
        () => threadTurns(thread.id),
        (r) => r[1]?.status === "failed",
      );

      expect(result[1]?.error_code).toBe("SERVICE_TIERS_UNSUPPORTED");
    } finally {
      legacy.holdTurns = false;
    }
  });

  test("unspecified bot speed remains compatible with an older worker", async () => {
    const bot = await addBot("", gw.workerId);
    await sendBot(bot.id);

    try {
      await eventually(
        async () => legacy.commands.filter((c) => c.case === "runBotTurn" && c.value.botId === bot.id),
        (commands) => commands.length === 1,
      );
    } finally {
      await gw.api.interruptBot({ botId: bot.id });
    }
  });
});
