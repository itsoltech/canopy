import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { FlatListProps } from "react-native";
import type { bots } from "@canopy/contracts";
import type { BotTimelineRow } from "@canopy/domain/bot-chat";
import { updateBotRead } from "../../state/bot-list";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { screenCovered, subscribeOverlays } from "../../ui/overlay-stack";

/** Acknowledge through the newest incoming row visible at the live end of the chat. */
export function useBotRead(conversation: bots.BotConversation | undefined, readingLatest: boolean) {
  const { client, queries } = useSession();
  const active = useAppActive();
  const covered = useSyncExternalStore(subscribeOverlays, screenCovered);
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());

  const onViewableItemsChanged = useCallback<NonNullable<FlatListProps<BotTimelineRow>["onViewableItemsChanged"]>>(
    ({ viewableItems }) => setVisible(new Set(viewableItems.map((row) => row.key))),
    [],
  );

  const bot = conversation?.bot;
  const botId = bot?.id;

  const throughSeq = bot?.unreadCount
    ? conversation?.messages.findLast(
        (message) =>
          message.seq > bot.lastReadSeq &&
          message.kind === "message" &&
          message.senderId === botId &&
          message.recipientId === "user" &&
          visible.has(message.id),
      )?.seq
    : undefined;

  useEffect(() => {
    if (!client || !active || covered || !readingLatest || !botId || !throughSeq) return;

    void client.api.markBotRead({ botId, throughSeq }).then(
      ({ bot }) => {
        if (bot) updateBotRead(queries, bot);
      },
      () => {},
    );
  }, [client, queries, active, covered, readingLatest, botId, throughSeq]);

  return onViewableItemsChanged;
}
