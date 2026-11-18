import type { bots } from "@canopy/contracts";

export interface ChatHistory {
  readonly snapshot: Pick<bots.BotConversation, "messages" | "historyHasMore" | "historyBeforeSeq"> | undefined;
  readonly loadingOlder: boolean;
  readonly historyError: string;
  loadOlder(): Promise<void>;
}
