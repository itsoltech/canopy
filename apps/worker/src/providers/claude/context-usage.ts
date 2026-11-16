import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEventInit } from "../../journal/index.ts";

/** Per-response main-loop usage, never result.usage or cumulative modelUsage token totals. */
export class ClaudeContextUsage {
  readonly #limits = new Map<string, number>();
  #model = "";
  #input: number | undefined;
  #output = 0;
  #uncachedInput = 0;
  #cacheCreation = 0;
  #cacheRead = 0;

  map(message: SDKMessage, turnId?: string): ThreadEventInit[] {
    if (
      message.type === "conversation_reset" ||
      (message.type === "system" && message.subtype === "compact_boundary")
    ) {
      this.#input = undefined;

      if (message.type === "conversation_reset") this.#limits.clear();

      return [this.#event(message, turnId)];
    }

    if (message.type === "result") {
      const limit = message.modelUsage?.[this.#model]?.contextWindow;

      if (!limit || !Number.isSafeInteger(limit) || limit <= 0 || this.#input === undefined) return [];
      this.#limits.set(this.#model, limit);

      return [this.#event(message, turnId)];
    }

    if (message.type === "assistant") {
      if (
        message.parent_tool_use_id ||
        message.error ||
        message.message.model === "<synthetic>" ||
        !message.message.usage
      )
        return [];
      this.#model = message.message.model;
      this.#read(message.message.usage);
    } else if (message.type === "stream_event" && !message.parent_tool_use_id) {
      if (message.event.type === "message_start") {
        this.#model = message.event.message.model;
        this.#read(message.event.message.usage);
      } else if (message.event.type === "message_delta" && this.#input !== undefined) {
        // The SDK emits assistant content blocks before the final message_delta usage.
        // Its output count is cumulative within this API response, not an increment.
        const usage = message.event.usage;
        this.#read({
          input_tokens: usage.input_tokens ?? this.#uncachedInput,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? this.#cacheCreation,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? this.#cacheRead,
          output_tokens: usage.output_tokens,
        });
      } else return [];
    } else return [];

    return [this.#event(message, turnId)];
  }

  #read(usage: {
    input_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens: number;
  }) {
    const values = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
    const input = values.reduce((sum, value) => sum + value, 0);
    this.#input = [...values, input, usage.output_tokens, input + usage.output_tokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
      ? input
      : undefined;
    this.#output = usage.output_tokens;
    this.#uncachedInput = usage.input_tokens;
    this.#cacheCreation = usage.cache_creation_input_tokens ?? 0;
    this.#cacheRead = usage.cache_read_input_tokens ?? 0;
  }

  #event(message: SDKMessage, turnId?: string): ThreadEventInit {
    const limit = this.#limits.get(this.#model);

    return {
      ...(turnId && { turnId }),
      rawJson: JSON.stringify(message),
      body: {
        case: "usageUpdated",
        value: {
          contextUsage: {
            ...(this.#input !== undefined && {
              usedTokens: BigInt(this.#input + this.#output),
              ...(limit && { limitTokens: BigInt(limit) }),
            }),
          },
        },
      },
    };
  }
}
