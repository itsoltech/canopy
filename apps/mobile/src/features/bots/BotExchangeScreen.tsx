import { useMemo } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  botParticipant,
  exchangeEntries,
  layoutChat,
  type ChatRow,
  type ParticipantView,
} from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { useBotExchange } from "../../state/bot-exchange";
import { ConversationSkeleton, Skeleton } from "../../ui/Skeleton";
import { ScreenHeader } from "../../ui/components";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { styles } from "../../ui/theme";
import { useFollowingList } from "../../ui/useFollowingList";
import { ChatRowView } from "./ChatTimeline";
import { BotAvatar } from "./BotAvatar";
import { HistoryFooter } from "../../ui/HistoryFooter";

/** The same history behind “Message from” and grouped exchanges, with a persistent read-only snapshot. */
export function BotExchangeScreen({ id, botId }: { id: string; botId?: string }) {
  const { session, bots } = useSession();
  const { snapshot, stream, history } = useBotExchange(id);
  const following = useFollowingList<ChatRow>();

  const participants = useMemo(
    () => [...new Map([...bots, ...(snapshot?.participants ?? [])].map((bot) => [bot.id, bot])).values()],
    [bots, snapshot?.participants],
  );

  const bot =
    participants.find((bot) => bot.id === botId) ??
    participants.find((bot) => snapshot?.messages.some((m) => m.botId === bot.id));

  const rows = useMemo(() => {
    const directory = new Map<string, ParticipantView>(participants.map((bot) => [bot.id, botParticipant(bot)]));

    return layoutChat({
      entries: exchangeEntries(snapshot?.messages ?? []),
      participants: directory,
      me: "me",
      kind: "watch",
    });
  }, [snapshot, participants]);

  if (!session) return <Redirect href="/pair" />;

  return (
    <SafeAreaView style={styles.fill} edges={["top", "left", "right"]}>
      <ScreenHeader
        title={bot?.configuration?.name ?? ""}
        loading={!bot}
        subtitle={stream.connection === "live" ? "Bot conversation" : "Syncing…"}
        right={
          bot ? <BotAvatar bot={bot} size={32} /> : <Skeleton style={{ width: 32, height: 32, borderRadius: 16 }} />
        }
      />
      <ConnectionBanner stream={stream} />
      <Animated.FlatList
        {...following.listProps}
        onEndReached={() => {
          if (!following.isFollowing()) void history.load();
        }}
        onEndReachedThreshold={0.3}
        data={[...rows].reverse()}
        keyExtractor={(row) => row.id}
        contentContainerStyle={[styles.page, { gap: 0, flexGrow: 1 }]}
        renderItem={({ item }) => <ChatRowView row={item} approvals={[]} readOnly />}
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            <HistoryFooter hasMore={snapshot?.historyHasMore} history={history} />
            {!snapshot && <ConversationSkeleton />}
          </View>
        }
      />
    </SafeAreaView>
  );
}
