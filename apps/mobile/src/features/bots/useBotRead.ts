import { useEffect } from "react";
import type { bots } from "@canopy/contracts";
import { BOT_LIST } from "../../state/bot-list";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";

/** Acknowledge the latest loaded message only while the live end of the chat is visible. */
export function useBotRead(conversation: bots.BotConversation | undefined, readingLatest: boolean) {
  const { client, queries } = useSession();
  const active = useAppActive();
  const botId = conversation?.bot?.id;
  const unread = Boolean(conversation?.bot?.unreadCount);
  const lastReadSeq = conversation?.bot?.lastReadSeq ?? 0n;
  const throughSeq = conversation?.messages.at(-1)?.seq ?? 0n;

  useEffect(() => {
    if (!client || !active || !readingLatest || !botId || !unread || throughSeq <= lastReadSeq) return;

    void client.api.markBotRead({ botId, throughSeq }).then(
      () => queries.invalidate(BOT_LIST),
      () => {},
    );
  }, [client, queries, active, readingLatest, botId, unread, lastReadSeq, throughSeq]);
}
