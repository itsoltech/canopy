import { isUuid } from "@canopy/domain/humanize";

export type UsageActivityKind = "thread" | "bot" | "generation" | "unattributed";

export interface UsageActivity {
  key: string;
  botName?: string;
}

export const isUsageBotId = (id: string) => id.length === 36 && isUuid(id);

export function readActivityKey(key: string): { kind: UsageActivityKind; botId: string } | undefined {
  switch (key) {
    case "thread":
    case "generation":
    case "unattributed":
      return { kind: key, botId: "" };
    default: {
      const botId = key.slice(4);

      return key.startsWith("bot:") && isUsageBotId(botId) ? { kind: "bot", botId: botId.toLowerCase() } : undefined;
    }
  }
}
