import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { v2 } from "@canopy/codex-protocol";
import { ClaudeConsumedUsage } from "./claude/consumed-usage.ts";
import { CodexConsumedUsage } from "./codex/consumed-usage.ts";
import { GrokSessionCost, grokPromptUsage } from "./grok/consumed-usage.ts";

// SAFETY: These checked-in fixtures are verbatim SDK messages from the pinned adapter version.
const claudeMessages = readFileSync(new URL("./claude/fixtures/text-turn.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as SDKMessage);

const result = claudeMessages.find((message): message is SDKResultMessage => message.type === "result")!;

const modelCounters = (inputTokens: number, outputTokens: number, costUSD: number) => ({
  inputTokens,
  outputTokens,
  costUSD,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 2,
  thinkingTokens: 1,
  contextWindow: 100000,
  maxOutputTokens: 10000,
  webSearchRequests: 0,
});

test("Claude per-result model accounting excludes inherited history and keeps auxiliary models separate", () => {
  const usage = new ClaudeConsumedUsage(true);

  const message = {
    ...result,
    modelUsage: { main: modelCounters(1000, 100, 10), helper: modelCounters(500, 40, 3) },
    model_usage_since_last_result: { main: modelCounters(11, 7, 0.2), helper: modelCounters(4, 2, 0.1) },
  };

  expect(usage.observe(message)).toMatchObject([
    { model: "main", inputTokens: 16n, outputTokens: 7n, reasoningOutputTokens: 1n, reportedCostUsd: 0.2 },
    { model: "helper", inputTokens: 9n, outputTokens: 2n, reportedCostUsd: 0.1 },
  ]);
  usage.beginTurn();
  expect(usage.observe(message).map((snapshot) => snapshot.inputTokens)).toEqual([16n, 9n]);
});

test("Claude stream and assistant blocks replace one response; result replaces live provisional counters", () => {
  const usage = new ClaudeConsumedUsage();
  const assistant = claudeMessages.find((message) => message.type === "assistant")!;
  usage.observe(assistant);
  const first = usage.snapshots();
  usage.observe(assistant);
  expect(usage.snapshots()).toEqual(first);
  expect(first[0]?.reportedCostUsd).toBeUndefined();
  usage.observe(result);
  expect(usage.snapshots()[0]?.reportedCostUsd).toBeGreaterThan(0);
  expect(usage.snapshots()[0]?.inputTokens).toBe(17281n);
});

test("Claude old producers use per-turn main-loop usage until a resumed baseline is known", () => {
  const usage = new ClaudeConsumedUsage(true);

  const old = {
    ...result,
    modelUsage: { main: modelCounters(1000, 100, 10) },
    model_usage_since_last_result: undefined,
  };

  expect(usage.observe(old)[0]?.reportedCostUsd).toBeUndefined();
  usage.beginTurn();
  const next = { ...old, modelUsage: { main: modelCounters(1010, 105, 10.2) } };
  expect(usage.observe(next)).toMatchObject([{ model: "main", inputTokens: 10n, outputTokens: 5n }]);
  expect(usage.snapshots()[0]?.reportedCostUsd).toBeCloseTo(0.2);
});

function tokens(inputTokens: number, outputTokens: number, reasoningOutputTokens = 0): v2.TokenUsageBreakdown {
  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    totalTokens: inputTokens + outputTokens,
  };
}

const update = (total: v2.TokenUsageBreakdown, last: v2.TokenUsageBreakdown): v2.ThreadTokenUsage => ({
  total,
  last,
  modelContextWindow: 100000,
});

const response = (responseId: string, amount: string | null): v2.RawResponseCompletedNotification => ({
  threadId: "thread",
  turnId: "one",
  responseId,
  usage: tokens(11, 7, 2),
  usageMetadata: { amount, metadata: null },
});

test("Codex resumed/forked cumulative counters exclude inherited totals across turns and resets", () => {
  const usage = new CodexConsumedUsage();
  usage.setModel("main");
  expect(usage.cumulative("history", update(tokens(1000, 100), tokens(100, 10)), false)).toEqual([]);
  expect(usage.cumulative("one", update(tokens(1011, 107, 2), tokens(11, 7, 2)), true)[0]).toMatchObject({
    inputTokens: 11n,
    outputTokens: 7n,
    reasoningOutputTokens: 2n,
  });
  expect(usage.cumulative("one", update(tokens(1011, 107, 2), tokens(11, 7, 2)), true)[0]?.outputTokens).toBe(7n);
  expect(usage.cumulative("two", update(tokens(1022, 114, 4), tokens(11, 7, 2)), true)[0]?.inputTokens).toBe(11n);
  expect(usage.cumulative("three", update(tokens(11, 7, 2), tokens(11, 7, 2)), true)[0]?.inputTokens).toBe(11n);
});

test("Codex response USD costs deduplicate and cover cumulative tokens only when all responses are priced", () => {
  const usage = new CodexConsumedUsage();
  expect(usage.response(response("a", "0"), true)[0]).toMatchObject({
    inputTokens: 11n,
    outputTokens: 7n,
    reasoningOutputTokens: 2n,
    reportedCostUsd: 0,
  });
  expect(usage.response(response("a", "0"), true)).toEqual([]);
  usage.cumulative("one", update(tokens(1011, 107, 2), tokens(11, 7, 2)), true);
  expect(usage.snapshots("one")[0]?.inputTokens).toBe(11n);
  expect(usage.snapshots("one")[0]?.reportedCostUsd).toBe(0);
  usage.response(response("b", "0.15"), true);
  expect(usage.snapshots("one")[0]?.inputTokens).toBe(22n);
  expect(usage.snapshots("one")[0]?.reportedCostUsd).toBeCloseTo(0.15);
  usage.cumulative("one", update(tokens(1033, 121, 6), tokens(11, 7, 2)), true);
  expect(usage.snapshots("one")[0]?.reportedCostUsd).toBeUndefined();
  usage.response(response("c", "2.5e-2"), true);
  expect(usage.snapshots("one")[0]?.inputTokens).toBe(33n);
  expect(usage.snapshots("one")[0]?.reportedCostUsd).toBeCloseTo(0.175);
  usage.response(response("d", null), true);
  usage.response(response("e", "123.45"), true);
  expect(usage.snapshots("one")[0]?.reportedCostUsd).toBeUndefined();
});

test("Codex absent, malformed and overflowing USD amounts stay unknown and inherited responses are ignored", () => {
  for (const amount of [null, "", " ", "-1", "NaN", "Infinity", "1e309", "0x10", "1.2USD"]) {
    const usage = new CodexConsumedUsage();
    expect(usage.response(response("history", "100"), false)).toEqual([]);
    expect(usage.response(response("a", amount), true)[0]?.reportedCostUsd).toBeUndefined();
  }

  const usage = new CodexConsumedUsage();
  usage.response(response("a", "1e308"), true);
  expect(usage.response(response("b", "1e308"), true)[0]?.reportedCostUsd).toBeUndefined();
});

test("Codex reroutes keep separate model buckets", () => {
  const usage = new CodexConsumedUsage();
  usage.setModel("main");
  usage.response(response("a", "0.1"), true);
  usage.setModel("fallback", "one");
  expect(usage.response(response("b", "0.2"), true).map((row) => row.model)).toEqual(["main", "fallback"]);
  expect(usage.snapshots("one").map((row) => row.reportedCostUsd)).toEqual([0.1, 0.2]);
  expect(usage.response(response("a", "0.1"), true)).toEqual([]);
});

test("Codex requested tier is frozen per native turn across late responses, reroutes and arbitrary native IDs", () => {
  const usage = new CodexConsumedUsage();
  usage.setRequestedServiceTier("priority", "one");
  usage.beginTurn("one");
  usage.response(response("a", null), true);
  usage.setRequestedServiceTier("default");
  usage.beginTurn("two");
  usage.response({ ...response("b", null), turnId: "two" }, true);
  usage.setModel("fallback", "one");
  usage.response(response("late", null), true);
  expect(usage.snapshots("one").map((snapshot) => snapshot.requestedServiceTier)).toEqual(["priority", "priority"]);
  expect(usage.snapshots("two")[0]?.requestedServiceTier).toBe("default");
});

test("Codex buffered provider wakeups inherit the preceding accepted choice before the next command turn", () => {
  const usage = new CodexConsumedUsage();
  usage.setRequestedServiceTier("fast", "one");
  usage.setModel("first", "one");
  usage.beginTurn("one");
  usage.setRequestedServiceTier("default", "next-command");
  usage.setModel("second", "next-command");
  usage.beginTurn("provider-wakeup");
  usage.response({ ...response("wake", null), turnId: "provider-wakeup" }, true);
  usage.beginTurn("next-command");
  usage.response({ ...response("next", null), turnId: "next-command" }, true);
  expect(usage.snapshots("provider-wakeup")[0]).toMatchObject({ model: "first", requestedServiceTier: "fast" });
  expect(usage.snapshots("next-command")[0]).toMatchObject({ model: "second", requestedServiceTier: "default" });
});

test("Claude mapper captures requested speed for live and terminal snapshots and resets it only for a new turn", async () => {
  const { ClaudeEventMapper } = await import("./claude/mapping.ts");
  const mapper = new ClaudeEventMapper("one", false, "fast");
  const assistant = claudeMessages.find((message) => message.type === "assistant")!;

  const snapshots = (messages: SDKMessage[]) =>
    messages
      .flatMap((message) => mapper.map(message))
      .flatMap((event) => {
        const body = event.body;

        return body?.case === "usageUpdated" || body?.case === "turnFinished" ? [body.value.usage].filter(Boolean) : [];
      });

  expect(snapshots([assistant]).at(-1)?.requestedServiceTier).toBe("fast");
  mapper.continueTurn("one");
  expect(snapshots([result]).at(-1)?.requestedServiceTier).toBe("fast");
  mapper.beginTurn("two", "default");
  expect(snapshots([assistant, result]).every((usage) => usage?.requestedServiceTier === "default")).toBe(true);
});

test("Grok complete metadata is per prompt; context occupancy never becomes consumed tokens", () => {
  const completion = {
    type: "complete" as const,
    stopReason: "end_turn",
    _meta: {
      modelId: "grok",
      usage: { inputTokens: 11, outputTokens: 7, cachedReadTokens: 3, cacheCreationTokens: 2, reasoningTokens: 2 },
    },
  };

  expect(grokPromptUsage(completion)).toMatchObject([
    {
      model: "grok",
      inputTokens: 11n,
      outputTokens: 7n,
      cachedInputTokens: 3n,
      cacheWriteInputTokens: 2n,
      reasoningOutputTokens: 2n,
    },
  ]);
  expect(grokPromptUsage({ type: "complete", stopReason: "cancelled", usage: { used: 5000, size: 100000 } })).toEqual(
    [],
  );
  expect(grokPromptUsage(completion)[0]?.reportedCostUsd).toBeUndefined();
});

test("Grok session USD costs require a known baseline and reject unsupported currency and invalid amounts", () => {
  const costs = new GrokSessionCost(true);
  costs.beginTurn();
  expect(costs.observe({ amount: 10, currency: "USD" })).toBeUndefined();
  costs.beginTurn();
  expect(costs.observe({ amount: 10, currency: "USD" })).toBe(0);
  expect(costs.observe({ amount: 10.2, currency: "USD" })).toBeCloseTo(0.2);
  expect(costs.observe({ amount: 10, currency: "EUR" })).toBeUndefined();
  expect(costs.observe({ amount: -1, currency: "USD" })).toBeUndefined();
});

test("Claude cumulative results omit inactive historical models", () => {
  const usage = new ClaudeConsumedUsage();

  const first = {
    ...result,
    modelUsage: { main: modelCounters(10, 5, 0.1), helper: modelCounters(4, 2, 0.1) },
    model_usage_since_last_result: undefined,
  };

  usage.observe(first);
  usage.beginTurn();

  const snapshots = usage.observe({
    ...first,
    modelUsage: { main: modelCounters(20, 10, 0.2), helper: first.modelUsage.helper },
  });

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ model: "main", inputTokens: 10n, outputTokens: 5n });
});

test("late Codex turn counters cannot reset the baseline of a running turn", () => {
  const usage = new CodexConsumedUsage();
  usage.cumulative("history", update(tokens(1000, 100), tokens(100, 10)), false);
  usage.beginTurn("one");
  usage.cumulative("one", update(tokens(1011, 107), tokens(11, 7)), true);
  usage.beginTurn("two");
  expect(usage.cumulative("one", update(tokens(1000, 100), tokens(100, 10)), true)).toEqual([]);
  expect(usage.cumulative("two", update(tokens(1022, 114), tokens(11, 7)), true)[0]?.inputTokens).toBe(11n);
});

test("Claude transcript accounting deduplicates response blocks and preserves actual models after a crash", async () => {
  const { ClaudeTranscriptUsage } = await import("./claude/transcript-usage.ts");
  const usage = new ClaudeTranscriptUsage();

  const entry = {
    type: "assistant",
    message: {
      id: "response",
      model: "served-model",
      usage: { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 7 },
    },
  };

  usage.observe(entry);
  usage.observe(entry);
  expect(usage.snapshots()).toMatchObject([{ model: "served-model", inputTokens: 16n, outputTokens: 7n }]);
});
