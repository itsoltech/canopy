import { describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { startInstanceFixture } from "./support/instance-fixture.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot Runs on defaults", () => {
  for (const role of ["desktop", "server"] as const) {
    test(`${role} selects the expected eligible worker and persists its choice`, async () => {
      const f = await startInstanceFixture(true, {
        role,
        worker: { hello: { capabilities: ["bot_harness_v1", "bot_web_v1"] } },
      });

      try {
        await f.save(Provider.CODEX, "bot-native");
        await f.gw.api.setInstanceModels({
          harness: Provider.CODEX,
          id: "native",
          models: { custom: ["fixture-model"] },
        });
        await f.gw.api.setInstanceWorkers({ harness: Provider.CODEX, id: "native", allWorkers: true });
        await f.gw.api.renameWorker({ workerId: f.gw.workerId, name: "A server worker" });

        const bot = (
          await f.gw.api.createBot({
            clientRequestId: crypto.randomUUID(),
            configuration: {
              name: `${role} default`,
              shape: "round",
              color: "#22aaff",
              provider: Provider.CODEX,
              providerInstance: "native",
              model: "fixture-model",
            },
          })
        ).bot!;

        f.gw.core.bots.start();
        await f.gw.api.sendBotMessage({ botId: bot.id, text: "Choose once", clientRequestId: crypto.randomUUID() });
        const expected = role === "desktop" ? f.workerId : f.gw.workerId;

        const result = await eventually(
          () => f.gw.api.getBot({ botId: bot.id }),
          (r) => !!r.bot?.configuration?.workerId,
        );

        expect(result.bot?.configuration?.workerId).toBe(expected);
        await f.gw.api.interruptBot({ botId: bot.id });
        expect((await f.gw.api.getBot({ botId: bot.id })).bot?.configuration?.workerId).toBe(expected);
      } finally {
        await f.close();
      }
    }, 20_000);
  }
});
