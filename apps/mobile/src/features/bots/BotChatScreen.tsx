import { useMemo, useState } from "react";
import { View } from "react-native";
import { ArrivingCell, useArrivals } from "../../ui/MotionViews";
import { Skeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { TimelineList } from "../composer/TimelineList";
import type { bots } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { useComputerHome } from "../computers/presence";
import { botParticipant, type BotTimelineRow } from "@canopy/domain/bot-chat";
import { useAppearance } from "../../state/appearance";
import { useSession } from "../../state/session";
import { useBotList } from "../../state/bot-list";
import { useBotSnapshot } from "../../state/bot";
import { HistoryFooter } from "../../ui/HistoryFooter";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { IconButton, Notice, ScreenHeader } from "../../ui/components";
import { styles } from "../../ui/theme";
import { ChatKeyboard } from "../composer/ChatKeyboard";
import { ChatRowView, useChatRows } from "./ChatTimeline";
import { ChatEventGroupHeader } from "./ChatEventGroupHeader";
import { FeedAnchorCell, FeedAnchorProvider, useFeedAnchor } from "../../ui/feed-anchor";
import { BotStatusRow } from "./ChatRows";
import { BotDetailsPanel } from "./BotDetailsPanel";
import { BotAvatar } from "./BotAvatar";
import { useFollowingList } from "../../ui/useFollowingList";
import { useLayout } from "../../state/layout";
import { SidebarToggle } from "../navigation/SidebarToggle";
import { FloatingComposer } from "../composer/FloatingComposer";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { useBotMessage } from "./useBotMessage";
import { useBotRead } from "./useBotRead";
import { BotComposer } from "./BotComposer";
import { BotMentionSuggestions } from "./BotMentionSuggestions";
import { DropZone } from "../attachments/FileIntake";

const chatRowId = (row: BotTimelineRow) => row.id;

function useBotChat(id: string) {
  const { session, client, online, bots: known } = useSession();
  const history = useBotSnapshot(id);
  const { snapshot: conversation, stream } = history;
  const [details, setDetails] = useState(false);
  const [stopping, setStopping] = useState(false);
  const following = useFollowingList<BotTimelineRow>(true);

  const stop = async () => {
    if (stopping || !client) return;
    setStopping(true);

    try {
      await client.api.interruptBot({ botId: id });
    } finally {
      setStopping(false);
    }
  };

  // Your other bots name the counterparts of bot ⇄ bot exchanges: the shared list keeps them current.
  useBotList();

  return {
    session,
    client,
    online,
    conversation,
    details,
    setDetails,
    stopping,
    stop,
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

function useBotConversation(id: string, rule: string) {
  const chat = useBotChat(id);
  const { threadsEnabled } = useAppearance();
  const { conversation, known, stream, following, seen } = chat;

  const home = useComputerHome(conversation?.bot?.nodeId || splitId(id).node);
  const bot = conversation?.bot ?? known.find((bot) => bot.id === id);
  const connected = stream.connection === "live" && !home.away;
  const live = connected && !bot?.archived;
  const onViewableItemsChanged = useBotRead(conversation, connected && following.atBottom && !chat.details && !rule);
  const message = useBotMessage(id, live, following.resumeFollowing, bot?.configuration?.name);

  const approvals = useMemo(
    () =>
      conversation?.approvals.filter(
        (a) =>
          (threadsEnabled || !a.threadId) &&
          (a.allowedByRule || a.status === "pending" || (a.status === "expired" && seen.has(a.id))),
      ) ?? [],
    [conversation?.approvals, threadsEnabled, seen],
  );

  const rows = useChatRows(conversation, approvals, known);
  const waiting = approvals.some((a) => a.status === "pending");

  const arrival = useArrivals(rows.latestFirst.map(chatRowId), Boolean(conversation), { newestFirst: true });

  const composer = useFloatingComposer(following, Boolean(message.draft.value.text.length || message.quotes.length));

  return { chat, home, bot, live, message, approvals, waiting, rows, arrival, composer, onViewableItemsChanged };
}

function BotConversation({ id, rule }: { id: string; rule: string }) {
  const state = useBotConversation(id, rule);
  const { chat, home, bot, live, message, composer } = state;
  const { draft, busy, error, setError } = message;
  const { conversation, following, setDetails } = chat;

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
        <DropZone draft={draft.files} disabled={!live || busy || !message.loaded}>
          <View style={styles.fill}>
            <BotChatFeed state={state} />
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
                stopping={chat.stopping}
                onStop={() => {
                  if (live)
                    void chat.stop().catch(() => setError("Could not stop the reply. Check the connection and retry."));
                }}
                disabled={!live || !chat.online || !conversation}
              />
            </FloatingComposer>
          </View>
        </DropZone>
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

function BotChatFeed({ state }: { state: ReturnType<typeof useBotConversation> }) {
  const { chat, live, message, approvals, waiting, rows, arrival, composer, onViewableItemsChanged } = state;
  const { following, history, conversation } = chat;
  const anchor = useFeedAnchor(following);

  return (
    <FeedAnchorProvider value={anchor}>
      <TimelineList
        disclosureAddsRows
        CellRendererComponent={FeedAnchorCell}
        {...composer.listProps}
        onViewableItemsChanged={onViewableItemsChanged}
        onEndReached={() => {
          if (!following.anchoring.get() && !following.isFollowing()) void history.load();
        }}
        onEndReachedThreshold={0.3}
        style={styles.fill}
        data={rows.latestFirst}
        keyExtractor={chatRowId}
        contentContainerStyle={[styles.page, { gap: 0, flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <ArrivingCell entering={arrival(item.id)}>
            {item.kind === "event-group" ? (
              <ChatEventGroupHeader
                count={item.events.length}
                open={rows.open.has(item.id)}
                onToggle={() => rows.toggle(item.id)}
              />
            ) : (
              <ChatRowView
                row={item}
                approvals={approvals}
                readOnly={!live}
                onAnswer={chat.answer}
                onSetReaction={message.setReaction}
                onReply={
                  message.busy
                    ? undefined
                    : (value) => {
                        composer.expand();
                        message.reply(value);
                      }
                }
              />
            )}
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
            <BotActivity conversation={conversation} waiting={waiting} />
            <View style={{ height: composer.height }} />
          </>
        }
      />
    </FeedAnchorProvider>
  );
}

function BotActivity({ conversation, waiting }: { conversation?: bots.BotConversation; waiting: boolean }) {
  return conversation?.bot && (conversation.working || conversation.statusLine) ? (
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
