import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { ServerNotification, v2 } from "@canopy/codex-protocol";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  Provider,
  RunBotTurnSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CodexConsumedUsage } from "./consumed-usage.ts";
import { OpenAiPricingCatalog } from "../pricing/openai-catalog.ts";
import { openAiPriceFixture } from "../fixtures/openai-pricing.ts";
import { generateCodexText } from "../generate-text.ts";
import { resolveProfiles } from "../profiles.ts";
import { Journal } from "../../journal/index.ts";
import { CodexThreads } from "./threads.ts";
import { runCodexBot } from "../../bots/codex.ts";
import { botSession } from "../../bots/session.ts";
import type { ConsumedUsage } from "../token-usage.ts";

const temporary = tempDirs();

const tokens = (
  inputTokens: number,
  outputTokens = 10,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
): v2.TokenUsageBreakdown => ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  reasoningOutputTokens: outputTokens / 2,
  totalTokens: inputTokens + outputTokens,
});

function raw(
  id: string,
  usage: v2.TokenUsageBreakdown | null,
): Extract<ServerNotification, { method: "rawResponse/completed" }> {
  return {
    method: "rawResponse/completed",
    params: { threadId: "thread", turnId: "turn", responseId: id, usage, usageMetadata: null },
  };
}

function counter(
  total: v2.TokenUsageBreakdown,
  last: v2.TokenUsageBreakdown,
): Extract<ServerNotification, { method: "thread/tokenUsage/updated" }> {
  return {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread", turnId: "turn", tokenUsage: { total, last, modelContextWindow: 1_000_000 } },
  };
}

test("response quotes freeze rates, apply each response's context/cache/tier and never price aggregate context", async () => {
  const root = temporary("canopy-codex-quotes-");
  let text = openAiPriceFixture;
  let now = 1_000_000;
  let requests = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;

      return new Response(text);
    },
  });

  const pricing = new OpenAiPricingCatalog(root, { source: `http://127.0.0.1:${server.port}/`, now: () => now });
  const consumed = new CodexConsumedUsage(pricing);
  consumed.setModel("fixture");
  consumed.setRequestedServiceTier("fast");

  try {
    const a = raw("a", tokens(200_000, 10, 100_000));
    await consumed.prepare(a, false);
    expect(requests).toBe(0);
    await consumed.prepare(a, true);
    expect(consumed.observe(a, true)[0]?.estimatedCostUsd).toBeCloseTo(0.4202);
    const b = raw("b", tokens(200_000, 10, 100_000));
    await consumed.prepare(b, true);
    const before = consumed.observe(b, true)[0];
    expect(before?.estimatedCostUsd).toBeCloseTo(0.8404);
    expect(before?.requestedServiceTier).toBe("fast");
    expect(requests).toBe(1);

    now += 86_400_001;
    text = text.replace("price = 2\n", "price = 3\n");
    const c = raw("c", tokens(100_000));
    await consumed.prepare(c, true);
    const changed = consumed.observe(c, true)[0];
    expect(changed?.estimatedCostUsd).toBeCloseTo(0.8404 + 0.6002);
    expect(changed?.pricingVersion).toContain(pricing.get("fixture")!.hash);
    expect(changed?.pricingVersion).toContain("quotes");
    expect(consumed.observe(a, true)).toEqual([]);
    expect(consumed.snapshots("turn")[0]?.estimatedCostUsd).toBe(changed?.estimatedCostUsd);

    const large = raw("large", tokens(280_000, 10, 100_000));
    await consumed.prepare(large, true);
    expect(consumed.observe(large, true)[0]?.estimatedCostUsd).toBeCloseTo(0.8404 + 0.6002 + 1.4803);
    consumed.observe(raw("unknown-ttl", tokens(10, 10, 0, 5)), true);
    expect(consumed.snapshots("turn")[0]?.estimatedCostUsd).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("resumed counters price only proven single responses and share frozen quotes with late raw duplicates", async () => {
  const root = temporary("canopy-codex-resumed-quotes-");
  let now = 1000;
  let text = openAiPriceFixture;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(text) });
  const pricing = new OpenAiPricingCatalog(root, { source: `http://127.0.0.1:${server.port}/`, now: () => now });
  const consumed = new CodexConsumedUsage(pricing);
  consumed.setModel("fixture");
  consumed.setRequestedServiceTier("default");

  try {
    // History establishes the baseline without fetching or charging old tokens.
    const history = counter(tokens(1_000_000, 100), tokens(200_000));
    await consumed.prepare(history, false);
    consumed.observe(history, false);
    const first = counter(tokens(1_200_000, 110), tokens(200_000));
    await consumed.prepare(first, true);
    expect(consumed.observe(first, true)[0]?.estimatedCostUsd).toBeCloseTo(0.4001);
    const old = consumed.snapshots("turn")[0];
    expect(consumed.observe(first, true)[0]?.estimatedCostUsd).toBe(old?.estimatedCostUsd);
    now += 86_400_001;
    text = text.replace("price = 2\n", "price = 3\n");
    const duplicate = raw("late-first", tokens(200_000));
    await consumed.prepare(duplicate, true);
    expect(consumed.observe(duplicate, true)[0]?.estimatedCostUsd).toBe(old?.estimatedCostUsd);
    expect(consumed.snapshots("turn")[0]?.pricingVersion).toBe(old?.pricingVersion);
    const second = counter(tokens(1_400_000, 120), tokens(200_000));
    await consumed.prepare(second, true);
    expect(consumed.observe(second, true)[0]?.estimatedCostUsd).toBeCloseTo(1.0002);
    // A multi-response gap is never priced using the last response's context band.
    const gap = counter(tokens(1_800_000, 140), tokens(200_000));
    await consumed.prepare(gap, true);
    expect(consumed.observe(gap, true)[0]?.estimatedCostUsd).toBeUndefined();
    const fresh = new CodexConsumedUsage(pricing);
    fresh.setModel("fixture");
    fresh.setRequestedServiceTier("default");
    expect(fresh.observe(first, true)[0]?.estimatedCostUsd).toBeUndefined(); // No inherited baseline.

    const reset = new CodexConsumedUsage(pricing);
    reset.setModel("fixture");
    reset.setRequestedServiceTier("default");
    reset.observe(history, false);
    expect(reset.observe(counter(tokens(900_000, 90), tokens(200_000)), true)[0]?.estimatedCostUsd).toBeUndefined();

    const rawFirst = new CodexConsumedUsage(pricing);
    rawFirst.setModel("fixture");
    rawFirst.setRequestedServiceTier("default");
    const response = raw("before-counter", tokens(200_000));
    const firstQuote = rawFirst.observe(response, true)[0];
    now += 86_400_001;
    text = text.replace("price = 3\n", "price = 4\n");
    const repeat = counter(tokens(200_000), tokens(200_000));
    await rawFirst.prepare(repeat, true);
    expect(rawFirst.observe(repeat, true)[0]?.estimatedCostUsd).toBe(firstQuote?.estimatedCostUsd);
    expect(rawFirst.snapshots("turn")[0]?.pricingVersion).toBe(firstQuote?.pricingVersion);

    const missing = new CodexConsumedUsage(pricing);
    missing.setModel("fixture");
    missing.setRequestedServiceTier("default");
    missing.observe(raw("missing-usage", null), true);
    expect(missing.observe(repeat, true)[0]?.estimatedCostUsd).toBeUndefined();

    for (const tier of ["", "invented", "priority", "ultrafast", "flex", "default"]) {
      const usage = new CodexConsumedUsage(pricing);
      usage.setModel("fixture");
      usage.setRequestedServiceTier(tier);
      const priced = usage.observe(raw(tier || "missing", tokens(100)), true)[0];
      expect(priced?.requestedServiceTier).toBe(tier);

      if (!tier || tier === "invented") expect(priced?.estimatedCostUsd).toBeUndefined();
      else
        expect(priced?.estimatedCostUsd).toBeCloseTo(
          0.0005 * ({ priority: 2, ultrafast: 6, flex: 0.5, default: 1 }[tier] ?? 0),
        );
    }
  } finally {
    await server.stop(true);
  }
});

test("thread, resumed bot and disposable generation use the injected durable catalog at the provider boundary", async () => {
  const root = temporary("canopy-codex-pricing-adapters-");
  const fixture = join(import.meta.dir, "../fixtures/service-tiers.ts");
  const env = { PATH: process.env["PATH"], TIER_TRACE: join(root, "trace.jsonl"), TIER_BOT_COMPLETE: "1" };
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;
  const events: ThreadEvent[] = [];
  let requests = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;

      return new Response(openAiPriceFixture);
    },
  });

  const pricing = new OpenAiPricingCatalog(root, { source: `http://127.0.0.1:${server.port}/` });

  const runtime = ManagedRuntime.make(
    CodexThreads.layer({
      pricing,
      launch: { command: [process.execPath, fixture, "--codex"], env },
      clientVersion: "test",
      profile: () => profile,
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
  );

  try {
    const threads = await runtime.runPromise(CodexThreads);

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      cwd: root,
      model: "fixture",
      serviceTier: "fast",
    });

    await runtime.runPromise(threads.create(spec));
    const turn = crypto.randomUUID();
    await runtime.runPromise(threads.startTurn(spec, turn, create(UserInputSchema, { text: "Hello" })));
    await runtime.runPromise(Effect.sleep("50 millis"));

    const threadUsage = events.flatMap((event) =>
      event.body.case === "usageUpdated" && event.body.value.usage ? [event.body.value.usage] : [],
    );

    expect(threadUsage.at(-1)?.estimatedCostUsd).toBeCloseTo(0.000024);
    expect(threadUsage.at(-1)?.requestedServiceTier).toBe("fast");
    expect(threadUsage.at(-1)?.pricingVersion).toContain(pricing.get("fixture")!.hash);

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider: Provider.CODEX,
      model: "fixture",
      serviceTier: "ultrafast",
      input: "Hello",
      historyJson: "[]",
    });

    const botUsages: number[] = [];

    for (let i = 0; i < 2; i++) {
      const session = botSession(input, { dataDir: root, sourceHome: root, linkLogin: false });

      if (i) expect(session.id).not.toBe("");
      await runCodexBot({
        pricing,
        input,
        session,
        profile: { ...profile, env: { TIER_TRACE: env.TIER_TRACE, TIER_BOT_COMPLETE: "1" } },
        executable: fixture,
        signal: AbortSignal.timeout(5000),
        clientVersion: "test",
        mcp: { url: "", headers: {} },
        record: async (event) => {
          if (event.body?.case === "usageUpdated") botUsages.push(event.body.value.usage?.estimatedCostUsd ?? -1);
        },
        noteHarness: async () => {},
        content: async () => ({ text: "Hello", images: [], documents: [] }),
      });
    }

    expect(botUsages).toEqual([0.000072, 0.000072]);
    const generationUsages: ConsumedUsage[] = [];
    await generateCodexText(
      { model: "fixture", effort: "", prompt: "Hello", onConsumedUsage: (usage) => generationUsages.push(usage) },
      {
        pricing,
        dataDir: root,
        profile,
        clientVersion: "test",
        launch: { command: [process.execPath, fixture, "--codex"], env },
      },
      AbortSignal.timeout(5000),
    );
    expect(generationUsages.at(-1)?.estimatedCostUsd).toBeCloseTo(0.000012);
    expect(generationUsages.at(-1)?.requestedServiceTier).toBe("default");
    expect(requests).toBe(1);
  } finally {
    await runtime.dispose();
    await server.stop(true);
  }
}, 15_000);

test("date-dependent Ultrafast rates use the frozen response date in Pacific time and preserve standard pricing", async () => {
  const root = temporary("canopy-codex-dated-pricing-");
  const before = Date.parse("2027-03-01T07:59:59.999Z");
  const after = Date.parse("2027-03-01T08:00:00.000Z");
  let now = before;

  const text = openAiPriceFixture.replace(
    'when = { service_tier = { equals = "ultrafast" } }\nfactor = { text = 6 }',
    `when = { service_tier = { equals = "ultrafast" }, date = { lt = "2027-03-01" } }
factor = { text = 3 }
[[cost.multipliers]]
when = { service_tier = { equals = "ultrafast" }, date = { gte = "2027-03-01" } }
factor = { text = 6 }`,
  );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      now = after; // The lookup crosses the pricing boundary; the response's observation time wins.

      return new Response(text);
    },
  });

  const pricing = new OpenAiPricingCatalog(root, { source: `http://127.0.0.1:${server.port}/`, now: () => now });
  const consumed = new CodexConsumedUsage(pricing);
  consumed.setModel("fixture");
  consumed.setRequestedServiceTier("ultrafast");

  try {
    const first = raw("before-midnight", tokens(100));
    await consumed.prepare(first, true);
    const firstUsage = consumed.observe(first, true)[0];
    expect(firstUsage?.estimatedCostUsd).toBeCloseTo(0.0009);
    expect(firstUsage?.pricingVersion).toContain("2027-02-28");
    const second = raw("at-midnight", tokens(100));
    await consumed.prepare(second, true);
    const combined = consumed.observe(second, true)[0];
    expect(combined?.estimatedCostUsd).toBeCloseTo(0.0027);
    expect(combined?.pricingVersion).toContain("2027-03-01");
    expect(consumed.observe(first, true)).toEqual([]);
    expect(consumed.snapshots("turn")[0]?.estimatedCostUsd).toBeCloseTo(0.0027);

    for (const instant of [before, after]) {
      now = instant;
      const standard = new CodexConsumedUsage(pricing);
      standard.setModel("fixture");
      standard.setRequestedServiceTier("default");
      expect(standard.observe(raw("standard", tokens(100)), true)[0]?.estimatedCostUsd).toBeCloseTo(0.0003);
    }
  } finally {
    await server.stop(true);
  }
});
