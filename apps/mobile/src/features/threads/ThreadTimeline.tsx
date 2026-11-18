import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { ProviderProfileKind, ui, type Item } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { FeedAnchorCell, FeedAnchorProvider, useFeedAnchor } from "../../ui/feed-anchor";
import { Notice } from "../../ui/components";
import { useMotion } from "../../ui/motion";
import { ArrivingCell, useArrivals } from "../../ui/MotionViews";
import { ConversationSkeleton } from "../../ui/Skeleton";
import { HistoryFooter } from "../../ui/HistoryFooter";
import { styles } from "../../ui/theme";
import { TimelineList } from "../composer/TimelineList";
import type { useFloatingComposer } from "../composer/useFloatingComposer";
import { TimelineDirectoryProvider, type TimelineDirectory } from "../timeline/directory";
import { NoticeRow } from "../timeline/NoticeRows";
import { TimelineTurn, type TurnContext } from "../timeline/TimelineTurn";
import { steeringNote, UserMessageView } from "../timeline/UserMessageView";
import { newDays } from "./thread-turns";
import { TimelineEntries } from "./timeline-entries";
import type { ThreadState } from "./ThreadScreen";
import { mobileFeedLayout } from "../settings/client-diagnostics";
import { turnNotices } from "@canopy/domain/turn-notices";
import { ThreadScrollItems, ThreadScrollParent, ThreadScrollTarget } from "../../ui/thread-scroll-items";
import { scrollTurnKey, useThreadScrollMemory } from "./useThreadScrollMemory";
import { RewindGroup, useRewindTimeline } from "./rewind-timeline";
import { useThreadSeen } from "./useThreadSeen";
import { ReplySendContext } from "../timeline/ReplySuggestions";
import type { NoticeState } from "@canopy/domain/turn-notices";
import { useThreadCreation } from "../new-thread/useThreadCreation";
import { ThreadPreparationTimeline } from "../new-thread/ThreadPreparationTimeline";
import { useThreadTimelineStyle } from "./timeline-layout";

/** What the timeline's items look up: other threads, items, deliveries, and its tasks by their command. */
function useTimelineData(state: ThreadState) {
  const { threads, workers } = useOverview();
  const { snapshot, thread } = state;

  const proxy =
    workers
      .find((w) => w.id === thread?.workerId)
      ?.providerInstances.find((i) => i.harness === thread?.provider && i.id === (thread.providerProfileId || "native"))
      ?.kind === ProviderProfileKind.CLIPROXYAPI;

  const quoteAction = useRef(state.quotes.add);
  const quote = useCallback((value: ui.Quote) => quoteAction.current(value), []);
  const editAction = useRef(state.rewind.open);
  useEffect(() => {
    quoteAction.current = state.quotes.add;
    editAction.current = state.rewind.open;
  }, [state.quotes.add, state.rewind.open]);
  const editFrom = useCallback((turn: ui.Turn) => editAction.current(turn), []);
  const away = state.home.away;
  const { foldChoices, groupChoices } = state.view;

  return useMemo(() => {
    const items = new Map(
      (snapshot?.items ?? []).flatMap((e): [string, Item][] => (e.item ? [[e.item.itemId, e.item]] : [])),
    );

    const tasks = new Map(
      [...items.values()].flatMap((item): [string, Item][] =>
        item.content.case === "backgroundTask" && item.content.value.sourceItemId
          ? [[item.content.value.sourceItemId, item]]
          : [],
      ),
    );

    const directory: TimelineDirectory = {
      currentId: thread?.id ?? "",
      quote,
      editFrom:
        !away &&
        thread?.runtime === "worker" &&
        !thread.spawnedByAgent &&
        !thread.scheduleId &&
        !thread.archivedAt &&
        !thread.rewindPending &&
        !thread.worktree?.removedAt
          ? editFrom
          : undefined,
      readOnly: away || !thread || Boolean(thread.archivedAt || thread.deletedAt || thread.worktree?.removedAt),
      thread: (id) => threads.find((t) => t.id === id) ?? (id === thread?.id ? thread : undefined),
      item: (id) => items.get(id),
      quoteTime: (id) => {
        const entry = snapshot?.items.find((e) => e.item?.itemId === id);
        const turn = state.turns.find((t) => t.id === entry?.turnId);
        const at = entry?.completedAt ?? turn?.completedAt ?? turn?.startedAt;

        return at ? new Date(Number(at.seconds) * 1000).toLocaleString() : undefined;
      },
      content: (id) => snapshot?.items.find((entry) => entry.item?.itemId === id)?.contentRef,
      delivery: (callId) => snapshot?.busDeliveries.find((d) => d.callId === callId),
      queuedFallback: (turnId) => snapshot?.steers.find((s) => s.status === "queued" && s.queuedTurnId === turnId),
    };

    const context: TurnContext = {
      notices: turnNotices(snapshot?.notices ?? [], state.turns, snapshot?.items ?? []),
      steers: snapshot?.steers ?? [],
      tasks,
      provider: thread?.provider,
      proxy,
      foldChoices,
      groupChoices,
    };

    return { directory, context };
  }, [snapshot, thread, threads, proxy, quote, editFrom, away, foldChoices, groupChoices, state.turns]);
}

/** Native anchoring/follow-state changes may update the list wrapper without rendering unchanged turns. */
const TimelineCell = memo(
  function TimelineCell({
    turn,
    entries,
    context,
    directory,
    newDay,
    historical,
    entering,
  }: {
    turn: ui.Turn;
    entries: readonly ui.TimelineItem[];
    context: TurnContext;
    directory: TimelineDirectory;
    newDay: boolean;
    historical: boolean;
    entering: ReturnType<typeof useMotion>["rise"]["entering"];
  }) {
    return (
      <ArrivingCell entering={entering}>
        <TimelineDirectoryProvider value={{ ...directory, sourceId: turn.fromThreadId || directory.currentId }}>
          <ThreadScrollParent.Provider value={scrollTurnKey(turn)}>
            <TimelineTurn turn={turn} entries={entries} context={context} newDay={newDay} historical={historical} />
          </ThreadScrollParent.Provider>
        </TimelineDirectoryProvider>
      </ArrivingCell>
    );
  },
  // Entrance presets only apply on mount; consuming an arrival must not render settled history again.
  (before, after) =>
    before.turn === after.turn &&
    before.entries === after.entries &&
    before.context === after.context &&
    before.directory === after.directory &&
    before.newDay === after.newDay &&
    before.historical === after.historical,
);

const EMPTY_ENTRIES: readonly ui.TimelineItem[] = [];

export function ThreadTimeline({
  state,
  composer,
}: {
  state: ThreadState;
  composer: ReturnType<typeof useFloatingComposer<ui.Turn>>;
}) {
  const { turns, following, snapshot } = state;
  const creation = useThreadCreation(state.id, true);
  const initial = Boolean(creation && turns.length === 1 && turns[0]?.ordinal === 1);
  const contentStyle = useThreadTimelineStyle(initial);
  const { directory, context } = useTimelineData(state);
  const anchor = useFeedAnchor(following);
  const rewind = useRewindTimeline(turns);
  const latestFirst = useMemo(() => [...rewind.shown].reverse(), [rewind.shown]);

  const memory = useThreadScrollMemory(
    state.id,
    latestFirst,
    Boolean(snapshot && (!creation || turns.length)),
    following,
    composer.listProps.onScroll,
    composer.restoreReading,
    creation,
  );

  useThreadSeen(state, memory.positioned);

  const arrival = useArrivals(latestFirst.map(scrollTurnKey), Boolean(snapshot), { newestFirst: true });
  const days = newDays(rewind.shown);
  const loose = context.notices.filter((n) => !n.turnId && n.notice?.code !== "thread_rewound");

  // Platform notes about CI checks are not messages waiting to join the turn.
  const steering =
    snapshot?.steers.filter((s) => ["pending", "accepted"].includes(s.status) && s.prChecks.length === 0) ?? [];

  const [entryIndex] = useState(() => new TimelineEntries());
  const entries = useMemo(() => entryIndex.build(snapshot?.items ?? []), [entryIndex, snapshot?.items]);

  if ((!snapshot || !turns.length) && creation)
    return <ThreadPreparationTimeline job={creation} inset={following.composerInset} />;

  return (
    <ReplySendContext.Provider value={state.replies}>
      <TimelineDirectoryProvider value={directory}>
        <ThreadScrollItems.Provider value={memory.items}>
          <ThreadScrollTarget.Provider value={memory.target}>
            <FeedAnchorProvider value={anchor}>
              <TimelineList
                {...composer.listProps}
                CellRendererComponent={FeedAnchorCell}
                onScroll={memory.onScroll}
                onTouchStart={memory.onTouchStart}
                onScrollToIndexFailed={memory.onScrollToIndexFailed}
                onViewableItemsChanged={memory.onViewableItemsChanged}
                composerInset={following.composerInset}
                onLayout={() => {
                  memory.restore();

                  if (snapshot?.thread) mobileFeedLayout(snapshot.thread.id);
                }}
                onContentSizeChange={() => {
                  memory.restore();

                  if (snapshot?.thread) mobileFeedLayout(snapshot.thread.id);
                }}
                onEndReached={() => {
                  if (memory.positioned && !following.anchoring.get() && !following.isFollowing())
                    void state.history.load();
                }}
                onEndReachedThreshold={0.3}
                data={latestFirst}
                keyExtractor={scrollTurnKey}
                style={[styles.fill, { opacity: memory.positioned ? 1 : 0 }]}
                contentContainerStyle={contentStyle}
                keyboardShouldPersistTaps="handled"
                // Inverted: the footer is the top of the feed, the header sits under the latest turn.
                ListFooterComponent={
                  <View style={{ gap: 16, paddingBottom: 16 }}>
                    <HistoryFooter
                      hasMore={snapshot?.historyHasMore || snapshot?.historyItemsHasMore}
                      history={state.history}
                    />
                    {!snapshot && <ConversationSkeleton />}
                    {snapshot?.thread && !turns.length && !state.archived && (
                      <Notice>This thread is ready for your first message.</Notice>
                    )}
                  </View>
                }
                // A turn that arrives (a sent or queued message) fades in; one that only scrolls into view does not, and
                // neither do the rows it mounts with. Later rows inside it animate themselves (TimelineTurn).
                renderItem={({ item, index }) => (
                  <RewindGroup
                    turn={item}
                    turns={turns}
                    rewind={rewind}
                    actions={state.rewind}
                    readOnly={directory.readOnly}
                  >
                    <TimelineCell
                      turn={item}
                      entries={entries.get(scrollTurnKey(item)) ?? EMPTY_ENTRIES}
                      context={context}
                      directory={directory}
                      newDay={days.has(item)}
                      historical={index !== 0}
                      entering={arrival(scrollTurnKey(item))}
                    />
                  </RewindGroup>
                )}
                ListHeaderComponent={<TimelineTail notices={loose} steers={steering} />}
              />
            </FeedAnchorProvider>
          </ThreadScrollTarget.Provider>
        </ThreadScrollItems.Provider>
      </TimelineDirectoryProvider>
    </ReplySendContext.Provider>
  );
}

function TimelineTail({
  notices,
  steers,
}: {
  notices: readonly (ui.ThreadNotice & NoticeState)[];
  steers: readonly ui.Steer[];
}) {
  const { rise } = useMotion();

  return (
    <View style={{ gap: 12, paddingBottom: steers.length || notices.length ? 12 : 0 }}>
      {notices.map((n) => (n.notice ? <NoticeRow key={String(n.seq)} notice={n.notice} state={n} /> : null))}
      {steers.map((s) => (
        <Animated.View key={s.id} entering={rise.entering} exiting={rise.exiting}>
          <UserMessageView
            text={s.text}
            mentions={s.mentions}
            attachments={s.attachments}
            note={steeringNote(s)}
            sender={s.sender}
            quotes={s.quotes}
            pending
          />
        </Animated.View>
      ))}
    </View>
  );
}
