import type { ServerNotification } from "@canopy/codex-protocol";
import type { JsonValue } from "@canopy/domain";
import { optionalTokenCount } from "../token-usage.ts";

/** Codex 0.164 recomputes retained history just before completing the item. This local estimate
 * sets only last.totalTokens. The compaction request's own input/output can arrive in between. */
export function retainedContext(last: {
  inputTokens: JsonValue | undefined;
  cachedInputTokens: JsonValue | undefined;
  cacheWriteInputTokens: JsonValue | undefined;
  outputTokens: JsonValue | undefined;
  reasoningOutputTokens: JsonValue | undefined;
  totalTokens: JsonValue | undefined;
}): bigint | undefined {
  return last.inputTokens === 0 &&
    last.cachedInputTokens === 0 &&
    (last.cacheWriteInputTokens ?? 0) === 0 &&
    last.outputTokens === 0 &&
    last.reasoningOutputTokens === 0
    ? optionalTokenCount(last.totalTokens)
    : undefined;
}

export class CodexCompaction {
  #last: bigint | undefined;
  #open: { id: string; turnId: string; preTokens: bigint | undefined; postTokens: bigint | undefined } | undefined;

  observe(notification: ServerNotification, latestTurn: string | undefined) {
    const params = notification.params;

    if ("turnId" in params && params.turnId !== latestTurn) return;

    switch (notification.method) {
      case "thread/tokenUsage/updated": {
        const { turnId, tokenUsage } = notification.params;
        this.#last = optionalTokenCount(tokenUsage.last.totalTokens);

        if (this.#open?.turnId === turnId) this.#open.postTokens = retainedContext(tokenUsage.last);

        return;
      }

      case "thread/compacted":
        this.#last = undefined;

        return;
      case "turn/started":
      case "turn/completed":
        if (notification.method === "turn/completed" && notification.params.turn.id !== latestTurn) return;

        if (this.#open) this.#last = undefined;
        this.#open = undefined;

        return;
      case "item/started":
      case "item/completed": {
        const { item, turnId } = notification.params;

        if (item.type !== "contextCompaction") return;

        if (notification.method === "item/started") {
          this.#open = { id: item.id, turnId, preTokens: this.#last, postTokens: undefined };

          return { preTokens: this.#last };
        }

        const open = this.#open;
        this.#open = undefined;
        this.#last = undefined;

        if (open?.id !== item.id || open.turnId !== turnId) return;
        this.#last = open.postTokens;

        return { preTokens: open.preTokens, postTokens: open.postTokens };
      }

      default:
        return;
    }
  }
}
