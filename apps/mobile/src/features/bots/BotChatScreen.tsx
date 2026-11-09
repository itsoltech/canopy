import { useEffect, useState } from "react";
import { View } from "react-native";
import { ArrivingCell, useArrivals } from "../../ui/MotionViews";
import { Skeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { TimelineList } from "../composer/TimelineList";
import type { bots } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { useComputerHome } from "../computers/presence";
import { botParticipant, type ChatRow } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { useBotSnapshot } from "../../state/bot";
import { HistoryFooter } from "../../ui/HistoryFooter";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { IconButton, Notice, ScreenHeader } from "../../ui/components";
import { styles } from "../../ui/theme";
import { ChatKeyboard } from "../composer/ChatKeyboard";
import { ChatRowView, useChatRows } from "./ChatTimeline";
import { BotStatusRow } from "./ChatRows";
import { BotDetailsPanel } from "./BotDetailsPanel";
import { BotAvatar } from "./BotAvatar";
import { useFollowingList } from "../../ui/useFollowingList";
import { useLayout } from "../../state/layout";
import { SidebarToggle } from "../navigation/SidebarToggle";
import { FloatingComposer } from "../composer/FloatingComposer";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { useBotMessage } from "./useBotMessage";
import { BotComposer } from "./BotComposer";
import { BotMentionSuggestions } from "./BotMentionSuggestions";

const chatRowId = (row: ChatRow) => row.id;

function useBotChat(id: string) {
  const { session, client, online, bots: known, updateBots } = useSession();
  const history = useBotSnapshot(id);
  const { snapshot: conversation, stream } = history;
  const [details, setDetails] = useState(false);
  const following = useFollowingList<ChatRow>(true);

  // Your other bots name the counterparts of bot ⇄ bot exchanges.
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.api
      .listBots({ includeArchived: true })
      .then((result) => active && updateBots(result.bots))
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [client, updateBots]);

  return {
    session,
    client,
    online,
    conversation,
    details,
    setDetails,
    following,
    stream,
    seen: history.seen,
    history: history.history,
    known,
    answer: history.answer,
  };
}

export function BotChatScreen({ id, rule = "" }: { id: string; rule?: string }) {
  return <BotConversation key={id} id={id} rule={rule} />;
}

function useBotConversation(id: string) {
  const chat = useBotChat(id);
  const { conversation, known, stream, following, seen } = chat;

  const home = useComputerHome(conversation?.bot?.nodeId || splitId(id).node);
  const bot = conversation?.bot ?? known.find((bot) => bot.id === id);
  const live = stream.connection === "live" && !home.away && !bot?.archived;
  const message = useBotMessage(id, live, following.resumeFollowing);

  const approvals =
    conversation?.approvals.filter(
      (a) => a.allowedByRule || a.status === "pending" || (a.status === "expired" && seen.has(a.id)),
    ) ?? [];

  const rows = useChatRows(conversation, approvals, known);
  const waiting = approvals.some((a) => a.status === "pending");

  const latestFirst = [...rows].reverse();
  const arrival = useArrivals(latestFirst.map(chatRowId), Boolean(conversation), { newestFirst: true });

  const composer = useFloatingComposer(following, Boolean(message.draft.value.text.length || message.quotes.length));

  return { chat, home, bot, live, message, approvals, waiting, latestFirst, arrival, composer };
}

function BotConversation({ id, rule }: { id: string; rule: string }) {
  const { chat, home, bot, live, message, approvals, waiting, latestFirst, arrival, composer } = useBotConversation(id);
  const { draft, busy, error, setError } = message;
  const { conversation, following, history, setDetails } = chat;

  if (!chat.session) return <Redirect href="/pair" />;

  return (
    <ScreenFrame
      header={
        <>
          <BotChatHeader bot={bot} syncing={Boolean(conversation && !live)} onDetails={() => setDetails(true)} />
          <ConnectionBanner stream={home.away ? undefined : chat.stream} />
        </>
      }
    >
      <ChatKeyboard composerHeight={composer.height}>
        <View style={styles.fill}>
          <TimelineList
            {...composer.listProps}
            onEndReached={() => {
              if (!following.isFollowing()) void history.load();
            }}
            onEndReachedThreshold={0.3}
            style={styles.fill}
            data={latestFirst}
            keyExtractor={chatRowId}
            contentContainerStyle={[styles.page, { gap: 0, flexGrow: 1 }]}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <ArrivingCell entering={arrival(item.id)}>
                <ChatRowView
                  row={item}
                  approvals={approvals}
                  readOnly={!live}
                  onAnswer={chat.answer}
                  onReply={
                    busy
                      ? undefined
                      : (value) => {
                          composer.expand();
                          message.reply(value);
                        }
                  }
                />
              </ArrivingCell>
            )}
            // Inverted: the footer is the top of the chat, the header sits under the latest message.
            ListFooterComponent={
              <HistoryFooter
                hasMore={conversation?.historyHasMore}
                history={history}
                skeleton={!conversation}
                empty={!!conversation && !conversation.messages.length}
              />
            }
            ListHeaderComponent={
              <>
                <BotTyping conversation={conversation} waiting={waiting} />
                <View style={{ height: composer.height }} />
              </>
            }
          />
          <FloatingComposer
            overlay={
              <BotMentionSuggestions
                id={id}
                trigger={draft.trigger}
                disabled={!live || busy}
                onPick={(option) => draft.pickMention(option.mention)}
              />
            }
            motion={composer.motion}
            onLayout={composer.measure}
            onExpand={composer.expand}
            onLatest={following.atBottom ? undefined : composer.showLatest}
          >
            {error ? <Notice error>{error}</Notice> : null}
            {home.away && (
              <Notice>
                {home.name} · {home.status}. Read only until it reconnects.
              </Notice>
            )}
            <BotComposer
              name={bot?.configuration?.name ?? ""}
              message={message}
              compact={composer.compact}
              onExpand={composer.expand}
              running={conversation?.working ?? false}
              onStop={() => {
                if (live)
                  void chat.client?.api
                    .interruptBot({ botId: id })
                    .catch(() => setError("Could not stop the bot. Check the connection and retry."));
              }}
              disabled={!live || !chat.online || !conversation}
            />
          </FloatingComposer>
        </View>
      </ChatKeyboard>
      <BotDetailsPanel
        conversation={conversation}
        readOnly={!live}
        visible={chat.details || !!rule}
        selectedRule={rule}
        onClose={() => {
          setDetails(false);

          if (rule) router.setParams({ rule: "" });
        }}
      />
    </ScreenFrame>
  );
}

function BotTyping({ conversation, waiting }: { conversation?: bots.BotConversation; waiting: boolean }) {
  return conversation?.working && conversation.bot ? (
    <View style={{ paddingTop: 12 }}>
      <BotStatusRow
        bot={botParticipant(conversation.bot)}
        text={conversation.statusLine || (waiting ? "Waiting for you" : "Typing…")}
        waiting={waiting}
      />
    </View>
  ) : null;
}

function BotChatHeader({
  bot,
  syncing,
  onDetails,
}: {
  bot: bots.Bot | undefined;
  syncing: boolean;
  onDetails: () => void;
}) {
  const { wide } = useLayout();

  return (
    <ScreenHeader
      title={bot?.configuration?.name ?? ""}
      loading={!bot}
      subtitle={syncing ? "Syncing…" : undefined}
      left={wide ? <SidebarToggle /> : undefined}
      right={
        <View style={styles.row}>
          {bot ? <BotAvatar bot={bot} size={32} /> : <Skeleton style={{ width: 32, height: 32, borderRadius: 16 }} />}
          <IconButton icon="ellipsis-horizontal" label="Bot details" onPress={onDetails} />
        </View>
      }
    />
  );
}
