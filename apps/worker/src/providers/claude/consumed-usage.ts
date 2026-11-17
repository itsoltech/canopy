import type { SDKMessage, ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";
import {
  addUsage,
  emptyUsage,
  reportedUsd,
  tokenCount,
  usageDifference,
  tokenFields,
  type ConsumedUsage,
} from "../token-usage.ts";
import { isTaskNotificationAck } from "./goal-mapping.ts";

const ModelCounters = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadInputTokens: Schema.Number,
  cacheCreationInputTokens: Schema.Number,
  thinkingTokens: Schema.optionalKey(Schema.Number),
  costUSD: Schema.Number,
});

// CLI extension omitted by SDKMessage: per-result pipeline usage, including compaction.
const resultDelta = Schema.decodeUnknownOption(
  Schema.Struct({
    model_usage_since_last_result: Schema.optionalKey(Schema.Record(Schema.String, ModelCounters)),
  }),
);

const apiReasoning = Schema.decodeUnknownOption(
  Schema.Struct({
    output_tokens_details: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ thinking_tokens: Schema.optionalKey(Schema.Number) })),
    ),
  }),
);

type Counters = Pick<
  ModelUsage,
  "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "thinkingTokens" | "costUSD"
>;

function modelUsage(model: string, usage: Counters): ConsumedUsage {
  return {
    ...emptyUsage(),
    inputTokens:
      tokenCount(usage.inputTokens) +
      tokenCount(usage.cacheReadInputTokens) +
      tokenCount(usage.cacheCreationInputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cachedInputTokens: tokenCount(usage.cacheReadInputTokens),
    cacheWriteInputTokens: tokenCount(usage.cacheCreationInputTokens),
    reasoningOutputTokens: tokenCount(usage.thinkingTokens),
    ...(reportedUsd(usage.costUSD) !== undefined && { reportedCostUsd: usage.costUSD }),
    model,
  };
}

/** Per-model, per-platform-turn snapshots; inherited session totals are never consumption. */
export class ClaudeConsumedUsage {
  #previous: Map<string, ConsumedUsage> | undefined;
  readonly #unknownCosts = new Set<string>();
  readonly #settled = new Map<string, ConsumedUsage>();
  readonly #responses = new Map<string, ConsumedUsage>();
  readonly #streams = new Map<string, string>();
  #model = "";
  #requestedServiceTier: string;

  constructor(resumed = false, requestedServiceTier = "") {
    this.#requestedServiceTier = requestedServiceTier;
    this.#previous = resumed ? undefined : new Map();
  }

  beginTurn(requestedServiceTier = ""): void {
    this.#requestedServiceTier = requestedServiceTier;
    this.#settled.clear();
    this.#unknownCosts.clear();
    this.#responses.clear();
    this.#streams.clear();
  }

  snapshots(): ConsumedUsage[] {
    const models = new Map([...this.#settled].map(([model, usage]) => [model, { ...usage }]));

    for (const usage of this.#responses.values()) {
      const model = usage.model ?? "";
      const total = models.get(model) ?? { ...emptyUsage(), model };
      addUsage(total, usage);
      // Streamed responses have no cost metadata, even after an earlier settled result.
      delete total.reportedCostUsd;
      models.set(model, total);
    }

    return [...models.values()].flatMap((usage) =>
      tokenFields.some((key) => usage[key] > 0n) || (usage.reportedCostUsd ?? 0) > 0
        ? [{ ...usage, requestedServiceTier: this.#requestedServiceTier }]
        : [],
    );
  }

  observe(message: SDKMessage): ConsumedUsage[] {
    if (message.type === "conversation_reset") {
      this.#previous = new Map();

      return [];
    }

    if (message.type === "result") return this.#result(message);

    if (
      message.type === "assistant" &&
      !message.error &&
      message.message.model !== "<synthetic>" &&
      message.message.usage
    ) {
      if (!message.parent_tool_use_id) this.#model = message.message.model;
      this.#responses.set(message.message.id, this.#apiUsage(message.message.usage, message.message.model));
    } else if (message.type === "stream_event") {
      const event = message.event;
      const lane = message.parent_tool_use_id ?? "";
      const messageId = this.#streams.get(lane) ?? "";

      if (event.type === "message_start") {
        this.#streams.set(lane, event.message.id);

        if (!message.parent_tool_use_id) this.#model = event.message.model;
        this.#responses.set(event.message.id, this.#apiUsage(event.message.usage, event.message.model));
      } else if (event.type === "message_delta" && this.#responses.has(messageId)) {
        const previous = this.#responses.get(messageId)!;
        const usage = event.usage;
        this.#responses.set(
          messageId,
          this.#apiUsage(
            {
              ...usage,
              input_tokens:
                usage.input_tokens ??
                Number(previous.inputTokens - previous.cachedInputTokens - previous.cacheWriteInputTokens),
              cache_read_input_tokens: usage.cache_read_input_tokens ?? Number(previous.cachedInputTokens),
              cache_creation_input_tokens: usage.cache_creation_input_tokens ?? Number(previous.cacheWriteInputTokens),
              output_tokens: usage.output_tokens,
            },
            previous.model,
          ),
        );
      } else return [];
    } else return [];

    return this.snapshots();
  }

  #result(message: Extract<SDKMessage, { type: "result" }>): ConsumedUsage[] {
    if (isTaskNotificationAck(message)) return [];

    const current = new Map(
      Object.entries(message.modelUsage ?? {}).map(([model, usage]) => [model, modelUsage(model, usage)]),
    );

    const extension = Option.getOrUndefined(resultDelta(message))?.model_usage_since_last_result;

    const deltas = extension
      ? Object.entries(extension).map(([model, usage]) => modelUsage(model, usage))
      : this.#previous && current.size
        ? [...current].map(([model, usage]) => ({
            ...usageDifference(usage, this.#previous?.get(model) ?? { ...emptyUsage(), reportedCostUsd: 0 }),
            model,
          }))
        : [
            {
              ...this.#apiUsage(
                message.usage,
                this.#model || (current.size === 1 ? ([...current.keys()][0] ?? "") : ""),
              ),
            },
          ];

    if (current.size) this.#previous = current;
    this.#responses.clear();

    for (const delta of deltas) {
      const model = delta.model ?? this.#model;

      if (
        !tokenFields.some((key) => delta[key] > 0n) &&
        !(delta.reportedCostUsd && delta.reportedCostUsd > 0) &&
        !this.#settled.has(model)
      )
        continue;
      const settled = this.#settled.get(model) ?? { ...emptyUsage(), model };
      addUsage(settled, delta);

      if (delta.reportedCostUsd === undefined) this.#unknownCosts.add(model);

      if (this.#unknownCosts.has(model)) delete settled.reportedCostUsd;
      this.#settled.set(model, settled);
    }

    return this.snapshots();
  }

  #apiUsage(
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    },
    model = this.#model,
  ): ConsumedUsage {
    return {
      ...emptyUsage(),
      inputTokens:
        tokenCount(usage.input_tokens) +
        tokenCount(usage.cache_read_input_tokens) +
        tokenCount(usage.cache_creation_input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      reasoningOutputTokens: tokenCount(
        Option.getOrUndefined(apiReasoning(usage))?.output_tokens_details?.thinking_tokens,
      ),
      cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheWriteInputTokens: tokenCount(usage.cache_creation_input_tokens),
      model,
    };
  }
}
