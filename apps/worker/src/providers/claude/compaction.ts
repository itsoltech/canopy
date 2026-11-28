import { ItemStatus } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { optionalTokenCount } from "../token-usage.ts";

export function claudeCompactionItem(
  uuid: string,
  preTokens: JsonValue | undefined,
  postTokens: JsonValue | undefined,
) {
  return {
    itemId: `compact:${uuid}`,
    status: ItemStatus.COMPLETED,
    content: {
      case: "contextCompaction" as const,
      value: { preTokens: optionalTokenCount(preTokens), postTokens: optionalTokenCount(postTokens) },
    },
  };
}
