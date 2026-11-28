import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type { FlatListProps } from "react-native";
import type { bots } from "@canopy/contracts";
import { containsChatMessage, type BotTimelineRow } from "@canopy/domain/bot-chat";
import { updateBotRead } from "../../state/bot-list";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { screenCovered, subscribeOverlays } from "../../ui/overlay-stack";

/** Both read receipts and history paging follow the rows the reader can actually see. */
export function useBotViewport() {
  const [visible, setVisible] = useState<ReadonlyMap<string, number>>(() => new Map());

  const onViewableItemsChanged = useCallback<NonNullable<FlatListProps<BotTimelineRow>["onViewableItemsChanged"]>>(
    ({ viewableItems }) => {
      const positions = new Map<string, number>();

      for (const { key, index } of viewableItems) {
        if (index != null) positions.set(key, index);
      }

      setVisible(positions);
    },
    [],
  );

  return { visible, onViewableItemsChanged };
}

export function useBotHistoryViewport(
  latestFirst: readonly BotTimelineRow[],
  visible: ReadonlyMap<string, number>,
  conversation: bots.BotConversation | undefined,
  connected: boolean,
  history: { loading: boolean; error: string; load: () => Promise<void> },
) {
  const oldest = conversation?.messages[0]?.id;
  const before = conversation?.historyBeforeSeq;
  const load = useEffectEvent(history.load);
  const ready = connected && conversation?.historyHasMore && !history.loading && !history.error;

  useEffect(() => {
    if (!ready || !visible.size) return;

    // Cards arrive with the controls and can extend well beyond the oldest paged message.
    const index = oldest ? latestFirst.findIndex((row) => containsChatMessage(row, oldest)) : -1;
    const boundary = index < 0 ? latestFirst.length - 1 : index;

    // FlatList reports its new viewport after render. A card moved by a prepend can still be in the old sample.
    for (const [id, position] of visible) {
      if (position >= boundary - 1 && latestFirst[position]?.id === id) {
        void load();

        return;
      }
    }
  }, [ready, before, oldest, latestFirst, visible]);
}

/** Acknowledge through the newest incoming row visible at the live end of the chat. */
export function useBotRead(
  conversation: bots.BotConversation | undefined,
  readingLatest: boolean,
  visible: ReadonlyMap<string, number>,
) {
  const { client, queries } = useSession();
  const active = useAppActive();
  const covered = useSyncExternalStore(subscribeOverlays, screenCovered);
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
}
