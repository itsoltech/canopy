import type { JsonObject, JsonValue } from "@canopy/domain";
import { jsonObject } from "../json.ts";
import { retainedContext } from "./compaction.ts";

/** Rollouts omit item_started. On installation Codex writes compacted, world_state, turn_context
 * and thread_settings_applied, followed by its recomputed token_count and the item completion. */
export class RolloutCompaction {
  #installed: { postTokens?: bigint } | undefined;

  observe(type: JsonValue | undefined, payload: JsonObject) {
    if (type === "compacted") {
      this.#installed = {};

      return this.#installed;
    }

    const installed = this.#installed;

    if (!installed || type === "world_state" || type === "turn_context") return;

    if (type === "event_msg") {
      if (payload["type"] === "thread_settings_applied") return;

      if (payload["type"] === "token_count") {
        const last = jsonObject(jsonObject(payload["info"])?.["last_token_usage"]);

        const count =
          last &&
          retainedContext({
            totalTokens: last["total_tokens"],
            inputTokens: last["input_tokens"],
            cachedInputTokens: last["cached_input_tokens"],
            cacheWriteInputTokens: last["cache_write_input_tokens"],
            outputTokens: last["output_tokens"],
            reasoningOutputTokens: last["reasoning_output_tokens"],
          });

        if (count !== undefined) installed.postTokens = count;
        else this.#installed = undefined;

        return;
      }

      if (payload["type"] === "item_completed" && jsonObject(payload["item"])?.["type"] === "ContextCompaction") {
        this.#installed = undefined;

        return installed;
      }
    }

    this.#installed = undefined;

    return;
  }
}
