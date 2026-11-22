import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ThreadEventSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { xaiPriceFixture } from "../fixtures/xai-pricing.ts";
import { XaiPricingCatalog } from "../pricing/model-catalog.ts";
import { GrokEventMapper } from "./mapping.ts";

test("ACP context reports replace used/size independently of cumulative dollar cost", () => {
  const mapper = new GrokEventMapper("turn", "/repo");

  const usage = (used: number, size: number) => {
    const mapped = mapper.update({
      sessionUpdate: "usage_update",
      used,
      size,
      cost: { currency: "USD", amount: 2 },
    })[0];

    if (!mapped?.body) throw new Error("Expected mapped update");
    const event = create(ThreadEventSchema, { body: mapped.body });

    if (event.body.case !== "usageUpdated") throw new Error("Expected usage update");

    return event.body.value;
  };

  expect(usage(12000, 100000).contextUsage).toMatchObject({ usedTokens: 12000n, limitTokens: 100000n });
  expect(usage(1000, 100000).contextUsage?.usedTokens).toBe(1000n);
  expect(usage(0, 0).contextUsage).toMatchObject({ usedTokens: 0n });
  expect(usage(0, 0).contextUsage?.limitTokens).toBeUndefined();
  expect(usage(NaN, Infinity).contextUsage?.usedTokens).toBeUndefined();
  expect(usage(NaN, Infinity).contextUsage?.limitTokens).toBeUndefined();
  expect(usage(12000, 100000).usage?.reportedCostUsd).toBeUndefined();
});

test("Grok prices prompt totals per reported model at xAI base rates and preserves independent USD reports", async () => {
  const paths: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);

      return path === "/grok-4.6.toml" ? new Response(xaiPriceFixture) : new Response(null, { status: 404 });
    },
  });

  const pricing = new XaiPricingCatalog(tempDir("canopy-xai-rates-"), { source: server.url.href });
  const mapper = new GrokEventMapper("turn", "/repo", undefined, pricing);
  const counters = { inputTokens: 250_000, outputTokens: 10_000, cachedReadTokens: 50_000, reasoningTokens: 5_000 };

  const completion = {
    type: "complete",
    stopReason: "end_turn",
    _meta: { modelId: "grok-4.6", usage: { ...counters, modelUsage: {} } },
  } as const;

  try {
    mapper.update({ sessionUpdate: "usage_update", used: 10, size: 500_000, cost: { currency: "USD", amount: 0 } });
    await mapper.complete(completion);
    expect(mapper.usage).toMatchObject([
      {
        model: "grok-4.6",
        reportedCostUsd: 0,
        estimatedCostUsd: 0.485,
        pricingVersion: expect.stringContaining("base-token-rates"),
      },
    ]);

    const multipleModels = {
      ...completion,
      stopReason: "cancelled",
      _meta: { usage: { ...counters, modelUsage: { "grok-4.6": counters, "unlisted-model": counters } } },
    };

    await mapper.complete(multipleModels);
    expect(mapper.usage).toMatchObject([
      { model: "grok-4.6", estimatedCostUsd: 0.485, reportedCostUsd: undefined },
      { model: "unlisted-model", inputTokens: 250_000n, reportedCostUsd: undefined },
    ]);
    expect(mapper.usage[1]?.estimatedCostUsd).toBeUndefined();
    expect(paths).toEqual(["/grok-4.6.toml", "/unlisted-model.toml"]);

    const invalid = { ...completion, _meta: { ...completion._meta, usage: { ...counters, inputTokens: -1 } } };
    await mapper.complete(invalid);
    expect(mapper.usage[0]?.estimatedCostUsd).toBeUndefined();

    const cacheWrite = {
      ...completion,
      _meta: { ...completion._meta, usage: { ...counters, cacheCreationTokens: 10_000 } },
    };

    await mapper.complete(cacheWrite);
    expect(mapper.usage[0]?.estimatedCostUsd).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});
