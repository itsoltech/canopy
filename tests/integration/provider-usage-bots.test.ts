import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("dedicated bot harness account limits", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  for (const provider of [Provider.CODEX, Provider.CLAUDE])
    test(`${Provider[provider]} bot reports limits for its source account over WorkerLink`, async () => {
      const bot = await f.add(provider);
      await f.send(bot.id, provider === Provider.CLAUDE ? "LIMIT:credits" : "LIMIT:warning");
      await f.settled(bot.id);

      const snapshot = await eventually(
        async () =>
          (await f.gw.api.getOverview({})).workers
            .find((w) => w.id === f.workerId)
            ?.providerInstances.find((i) => i.harness === provider && i.id === "native")?.usage,
        (u) => u?.windows.some((w) => w.key === "seven_day" && w.usedPercent === 92) ?? false,
      );

      expect(snapshot?.windows.some((w) => w.key === "seven_day" && w.usedPercent === 92)).toBe(true);

      if (provider === Provider.CLAUDE) expect(snapshot?.usingExtraUsage).toBe(true);
    }, 30_000);
});
