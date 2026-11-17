import { Option, Schema } from "effect";
import type { JsonObject } from "@canopy/domain";
import { addUsage, emptyUsage, tokenCount, type ConsumedUsage } from "../token-usage.ts";

const Entry = Schema.Struct({
  type: Schema.String,
  isApiErrorMessage: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
      usage: Schema.optionalKey(
        Schema.Struct({
          input_tokens: Schema.Number,
          output_tokens: Schema.Number,
          cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          output_tokens_details: Schema.optionalKey(
            Schema.Struct({ thinking_tokens: Schema.optionalKey(Schema.Number) }),
          ),
        }),
      ),
    }),
  ),
});

/** Assistant blocks repeat one API response's usage; only its latest observation counts. */
export class ClaudeTranscriptUsage {
  readonly #responses = new Map<string, ConsumedUsage>();

  observe(record: JsonObject): void {
    const entry = Option.getOrUndefined(Schema.decodeUnknownOption(Entry)(record));
    const message = entry?.message;
    const usage = message?.usage;

    if (
      entry?.type !== "assistant" ||
      entry.isApiErrorMessage ||
      !message?.id ||
      !message.model ||
      message.model === "<synthetic>" ||
      !usage
    )
      return;
    this.#responses.set(message.id, {
      ...emptyUsage(),
      model: message.model,
      inputTokens:
        tokenCount(usage.input_tokens) +
        tokenCount(usage.cache_read_input_tokens) +
        tokenCount(usage.cache_creation_input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheWriteInputTokens: tokenCount(usage.cache_creation_input_tokens),
      reasoningOutputTokens: tokenCount(usage.output_tokens_details?.thinking_tokens),
    });
  }

  snapshots(): ConsumedUsage[] {
    const models = new Map<string, ConsumedUsage>();

    for (const response of this.#responses.values()) {
      const model = response.model ?? "";
      const total = models.get(model) ?? { ...emptyUsage(), model };
      addUsage(total, response);
      models.set(model, total);
    }

    return [...models.values()];
  }
}
