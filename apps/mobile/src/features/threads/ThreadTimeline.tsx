import { useMemo, useState } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { ui, type Item } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { FeedAnchorProvider, useFeedAnchor } from "../../ui/feed-anchor";
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

/** What the timeline's items look up: other threads, items, deliveries, and its tasks by their command. */
function useTimelineData(state: ThreadState) {
  const { threads } = useOverview();
  const { snapshot, thread } = state;

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
    quote: state.quotes.add,
    readOnly: state.home.away || !thread || Boolean(thread.archivedAt || thread.deletedAt),
    thread: (id) => threads.find((t) => t.id === id) ?? (id === thread?.id ? thread : undefined),
    item: (id) => items.get(id),
    delivery: (callId) => snapshot?.busDeliveries.find((d) => d.callId === callId),
    queuedFallback: (turnId) => snapshot?.steers.find((s) => s.status === "queued" && s.queuedTurnId === turnId),
  };

  const context: TurnContext = {
    notices: snapshot?.notices ?? [],
    steers: snapshot?.steers ?? [],
    tasks,
    provider: thread?.provider,
  };

  return { directory, context };
}

export function ThreadTimeline({
  state,
  composer,
}: {
  state: ThreadState;
  composer: ReturnType<typeof useFloatingComposer<ui.Turn>>;
}) {
  const { appearance } = useAppearance();

  const maxWidth =
    appearance?.chatWidth === ui.ChatWidth.FULL ? undefined : appearance?.chatWidth === ui.ChatWidth.WIDE ? 1024 : 768;

  const { turns, following, snapshot } = state;
  const { directory, context } = useTimelineData(state);
  const anchor = useFeedAnchor(following.list, following.offset, following.isFollowing, following.minimum);
  const latestFirst = [...turns].reverse();
  const turnKey = (turn: ui.Turn) => `${turn.fromThreadId}:${turn.id}`;
  const arrival = useArrivals(latestFirst.map(turnKey), Boolean(snapshot), { newestFirst: true });
  const { rise } = useMotion();
  const days = newDays(turns);
  const turnIds = new Set(turns.map((t) => t.id));
  const loose = snapshot?.notices.filter((n) => !turnIds.has(n.turnId)).slice(-3) ?? [];
  const steering = snapshot?.steers.filter((s) => ["pending", "accepted"].includes(s.status)) ?? [];

  const [entryIndex] = useState(() => new TimelineEntries());
  const entries = useMemo(() => entryIndex.build(snapshot?.items ?? []), [entryIndex, snapshot?.items]);

  return (
    <TimelineDirectoryProvider value={directory}>
      <FeedAnchorProvider value={anchor}>
        <TimelineList
          {...composer.listProps}
          onEndReached={() => {
            if (!following.isFollowing()) void state.history.load();
          }}
          onEndReachedThreshold={0.3}
          data={latestFirst}
          keyExtractor={turnKey}
          style={styles.fill}
          contentContainerStyle={{ maxWidth, paddingTop: 24, flexGrow: 1, gap: 0 }}
          keyboardShouldPersistTaps="handled"
          // Inverted: the footer is the top of the feed, the header sits under the latest turn.
          ListFooterComponent={
            <View style={{ gap: 16, paddingBottom: 16 }}>
              <HistoryFooter hasMore={snapshot?.historyHasMore} history={state.history} />
              {!snapshot && <ConversationSkeleton />}
              {snapshot && !turns.length && <Notice>This thread is ready for your first message.</Notice>}
            </View>
          }
          // A turn that arrives (a sent or queued message) fades in; one that only scrolls into view does not, and
          // neither do the rows it mounts with. Later rows inside it animate themselves (TimelineTurn).
          renderItem={({ item, index }) => (
            <ArrivingCell entering={arrival(turnKey(item))}>
              <TimelineDirectoryProvider value={{ ...directory, sourceId: item.fromThreadId || directory.currentId }}>
                <TimelineTurn
                  turn={item}
                  entries={entries.get(turnKey(item)) ?? []}
                  context={context}
                  newDay={days.has(item)}
                  latest={index === 0}
                  onQueued={(turn) => state.setQueued({ turn, editing: false })}
                />
              </TimelineDirectoryProvider>
            </ArrivingCell>
          )}
          ListHeaderComponent={
            <>
              <View style={{ gap: 12, paddingBottom: steering.length || loose.length ? 12 : 0 }}>
                {loose.map((n) => (n.notice ? <NoticeRow key={String(n.seq)} notice={n.notice} /> : null))}
                {steering.map((s) => (
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
              <View style={{ height: composer.height }} />
            </>
          }
        />
      </FeedAnchorProvider>
    </TimelineDirectoryProvider>
  );
}
