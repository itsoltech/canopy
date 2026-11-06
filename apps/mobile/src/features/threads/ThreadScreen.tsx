import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Platform, Text, View } from "react-native";
import { ConversationSkeleton, SkeletonScope } from "../../ui/Skeleton";
import { Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { applyThread } from "../../api/thread";
import { useSession } from "../../state/session";
import { useThreadSnapshot } from "../../state/thread";
import { ConnectionNotice, LatestButton, Notice } from "../../ui/components";
import { TimelineTurn, type TurnContext } from "../timeline/TimelineTurn";
import { TimelineDirectoryProvider, type TimelineDirectory } from "../timeline/directory";
import { NoticeRow } from "../timeline/NoticeRows";
import { steeringNote, UserMessageView } from "../timeline/UserMessageView";
import { FeedAnchorProvider, useFeedAnchor } from "../../ui/feed-anchor";
import type { Item } from "@canopy/contracts";
import { styles, useColors } from "../../ui/theme";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { MessageComposer } from "./MessageComposer";
import { ThreadPanel } from "./ThreadPanel";
import { InteractionCard } from "./InteractionCard";
import { useOverview } from "../../state/overview";
import { ThreadHeader } from "./ThreadHeader";
import { SubagentStrip } from "./SubagentStrip";
import { useFollowingList } from "../../ui/useFollowingList";
import { useMessageDraft } from "../composer/useMessageDraft";
import { QueuedMessageMenu, QueueEditor } from "./QueuedMessage";
import { GoalSheet, isFinishedGoal, takesGoals } from "./GoalSheet";
import { SideThreadSheet } from "./SideThreadSheet";
import { useAppearance } from "../../state/appearance";
import { useComputerHome } from "../computers/presence";
import { splitId } from "@canopy/domain/computers";

function visibleTurns(snapshot: ui.ThreadSnapshot | undefined) {
  const turns = snapshot?.turns.filter((t) => !t.withdrawn).slice() ?? [];
  const known = new Set(turns.map((turn) => `${turn.fromThreadId}:${turn.id}`));

  // Provider-origin events can arrive before a turn update. Keep those entries visible.
  for (const item of snapshot?.items ?? []) {
    const key = `${item.fromThreadId}:${item.turnId}`;

    if (!known.has(key)) {
      known.add(key);
      turns.push(
        create(ui.TurnSchema, {
          id: item.turnId,
          fromThreadId: item.fromThreadId,
          inherited: item.inherited,
          trigger: "provider",
        }),
      );
    }
  }

  return turns;
}

/** The gateway refused the message and says why (not delivered: no retry note); otherwise delivery is unknown. */
function deliveryError(failure: ConnectError) {
  return [Code.InvalidArgument, Code.FailedPrecondition, Code.ResourceExhausted].includes(failure.code)
    ? failure.rawMessage
    : "Could not confirm delivery. Retry with the same text to send it only once.";
}

function useThreadState(id: string) {
  const { session, client, ready, online, expired } = useSession();
  const { snapshot, setSnapshot, stream } = useThreadSnapshot(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const following = useFollowingList<ui.Turn>();
  const [details, setDetails] = useState(false);
  const [queued, setQueued] = useState<{ turn: ui.Turn; editing: boolean }>();
  const { projects, workers, threads } = useOverview();
  const sending = useRef(false);
  const message = useMessageDraft();

  const pending = useRef<{
    text: string;
    delivery: ui.MessageDelivery;
    id: string;
  } | null>(null);

  const requestController = useRef(new AbortController());
  useEffect(() => {
    requestController.current = new AbortController();

    return () => requestController.current.abort();
  }, [id, client]);

  const thread = snapshot?.thread ?? threads.find((t) => t.id === id);
  const home = useComputerHome(thread?.nodeId || splitId(id).node);
  const worker = workers.find((w) => w.id === thread?.workerId);
  const subagents = threads.filter((t) => t.parentThreadId === id && !t.archivedAt && !t.deletedAt);
  const interactions = snapshot?.interactions.filter((i) => i.status === "pending") ?? [];
  const turns = useMemo(() => visibleTurns(snapshot), [snapshot]);

  async function send(requested: ui.MessageDelivery) {
    const outgoing = message.outgoing();
    const { text: value, attachmentIds, mentions } = outgoing;

    if (!client || (!value && !attachmentIds.length) || message.files.blocker || sending.current) return;
    sending.current = true;
    following.resumeFollowing();
    setBusy(true);
    setError("");

    // A message with files always waits in the queue (it never joins a running turn).
    const delivery = attachmentIds.length ? ui.MessageDelivery.QUEUE : requested;

    if (pending.current?.text !== value || pending.current.delivery !== delivery)
      pending.current = { text: value, delivery, id: Crypto.randomUUID() };

    try {
      const result = await client.api.sendMessage(
        {
          threadId: id,
          text: value,
          delivery,
          attachmentIds,
          mentions,
          clientRequestId: pending.current.id,
        },
        { signal: requestController.current.signal, timeoutMs: 20_000 },
      );

      if (result.turn)
        setSnapshot((s) =>
          s?.turns.some((turn) => turn.id === result.turn!.id)
            ? s
            : applyThread(
                s,
                create(ui.ThreadUpdateSchema, {
                  change: { case: "turn", value: result.turn! },
                }),
              ),
        );

      if (result.steer)
        setSnapshot((s) =>
          s?.steers.some((steer) => steer.id === result.steer!.id)
            ? s
            : applyThread(
                s,
                create(ui.ThreadUpdateSchema, {
                  change: { case: "steer", value: result.steer! },
                }),
              ),
        );
      message.clear();
      pending.current = null;
    } catch (e) {
      if (ConnectError.from(e).code === Code.Unauthenticated) await expired();
      else if (!requestController.current.signal.aborted) setError(deliveryError(ConnectError.from(e)));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const blocked =
    home.away ||
    !online ||
    !thread ||
    Boolean(thread.archivedAt || thread.deletedAt) ||
    thread.status === "archived" ||
    busy ||
    stream.connection !== "live";

  return {
    session,
    client,
    ready,
    snapshot,
    busy,
    error,
    setError,
    following,
    details,
    setDetails,
    projects,
    stream,
    thread,
    worker,
    subagents,
    interactions,
    turns,
    send,
    blocked,
    home,
    message,
    queued,
    setQueued,
  };
}

export function ThreadScreen({ id }: { id: string }) {
  const c = useColors();
  const state = useThreadState(id);
  const [sheet, setSheet] = useState<"goal" | "side" | null>(null);

  const {
    session,
    client,
    ready,
    snapshot,
    busy,
    error,
    setError,
    following,
    details,
    setDetails,
    projects,
    thread,
    worker,
    subagents,
    interactions,
    turns,
    send,
    blocked,
  } = state;

  const { atBottom, showLatest } = following;

  if (!ready) return <ConversationSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  return (
    <SafeAreaView style={styles.fill} edges={["top", "left", "right"]}>
      <ThreadHeader
        thread={thread}
        project={projects.find((p) => p.id === thread?.projectId)}
        turns={turns}
        onDetails={() => setDetails(true)}
        onSideThread={() => setSheet("side")}
        onGoal={thread && takesGoals(thread) ? () => setSheet("goal") : undefined}
        goalOpen={Boolean(snapshot?.goal && !isFinishedGoal(snapshot.goal.status))}
        readOnly={state.home.away}
      />
      <KeyboardArea>
        <ThreadTimeline state={state} />
        <View
          style={{
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 4,
            gap: 8,
            backgroundColor: c.background,
          }}
        >
          <LatestButton visible={!atBottom} onPress={showLatest} />
          {error ? <Notice error>{error}</Notice> : null}
          {state.home.away && (
            <Notice>
              {state.home.name} · {state.home.status}. Read only until it reconnects.
            </Notice>
          )}
          {!state.home.away &&
            interactions.slice(0, 1).map((i) => <InteractionCard key={i.requestId} interaction={i} />)}
          {interactions.length > 1 && (
            <Text style={[styles.meta, { color: c.warning }]}>+{interactions.length - 1} pending</Text>
          )}
          <SubagentStrip subagents={subagents} onFinished={() => setDetails(true)} />
          <SkeletonScope loading={!thread}>
            <MessageComposer
              thread={thread}
              worker={worker}
              message={state.message}
              send={(delivery) => void send(delivery)}
              stop={() =>
                void client!.api
                  .interruptThread({ threadId: id })
                  .catch(() => setError("Could not stop the turn. Try again."))
              }
              disabled={blocked}
              busy={busy}
              onDetails={() => setDetails(true)}
              onGoal={() => setSheet("goal")}
            />
          </SkeletonScope>
        </View>
      </KeyboardArea>
      <ThreadPanel snapshot={snapshot} visible={details} onClose={() => setDetails(false)} />
      <QueuedMessageMenu
        turn={state.home.away || state.queued?.editing ? undefined : state.queued?.turn}
        onClose={() => state.setQueued(undefined)}
        onEdit={(turn) => state.setQueued({ turn, editing: true })}
        onError={setError}
      />
      <GoalSheet
        thread={thread}
        goal={snapshot?.goal}
        visible={!state.home.away && sheet === "goal"}
        onClose={() => setSheet(null)}
      />
      <SideThreadSheet main={thread} visible={!state.home.away && sheet === "side"} onClose={() => setSheet(null)} />
      <QueueEditor
        turn={!state.home.away && state.queued?.editing ? state.queued.turn : undefined}
        onClose={() => state.setQueued(undefined)}
      />
    </SafeAreaView>
  );
}

/** The new-day flag of each turn: it starts a calendar day the turns before it did not (web: buildTimeline). */
function newDays(turns: readonly ui.Turn[]): ReadonlySet<ui.Turn> {
  const days = new Set<ui.Turn>();
  let last = "";

  for (const turn of turns) {
    const at = turn.startedAt ?? turn.queuedAt;

    if (!at) continue;
    const date = new Date(Number(at.seconds) * 1000);
    const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

    if (day !== last) days.add(turn);
    last = day;
  }

  return days;
}

/** What the timeline's items look up: other threads, items, deliveries, and its tasks by their command. */
function useTimelineData(state: ReturnType<typeof useThreadState>) {
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
    readOnly: state.home.away || !thread || Boolean(thread.archivedAt || thread.deletedAt),
    thread: (id) => threads.find((t) => t.id === id) ?? (id === thread?.id ? thread : undefined),
    item: (id) => items.get(id),
    delivery: (callId) => snapshot?.busDeliveries.find((d) => d.callId === callId),
  };

  const context: TurnContext = {
    notices: snapshot?.notices ?? [],
    steers: snapshot?.steers ?? [],
    tasks,
    provider: thread?.provider,
  };

  return { directory, context };
}

function ThreadTimeline({ state }: { state: ReturnType<typeof useThreadState> }) {
  const c = useColors();
  const { appearance } = useAppearance();

  const maxWidth =
    appearance?.chatWidth === ui.ChatWidth.FULL ? undefined : appearance?.chatWidth === ui.ChatWidth.WIDE ? 1024 : 768;

  const { turns, following, stream, snapshot } = state;
  const { directory, context } = useTimelineData(state);
  const anchor = useFeedAnchor(following.list, following.offset, following.isFollowing);
  const latestFirst = [...turns].reverse();
  const days = newDays(turns);
  const turnIds = new Set(turns.map((t) => t.id));
  const loose = snapshot?.notices.filter((n) => !turnIds.has(n.turnId)).slice(-3) ?? [];
  const steering = snapshot?.steers.filter((s) => ["pending", "accepted"].includes(s.status)) ?? [];

  const entries = useMemo(() => {
    const grouped = new Map<string, ui.TimelineItem[]>();

    for (const item of snapshot?.items ?? []) {
      const key = `${item.fromThreadId}:${item.turnId}`;
      const group = grouped.get(key) ?? [];
      group.push(item);
      grouped.set(key, group);
    }

    return grouped;
  }, [snapshot?.items]);

  return (
    <TimelineDirectoryProvider value={directory}>
      <FeedAnchorProvider value={anchor}>
        <FlatList
          {...following.listProps}
          data={latestFirst}
          keyExtractor={(turn) => `${turn.fromThreadId}:${turn.id}`}
          style={styles.fill}
          contentContainerStyle={[styles.page, { maxWidth, paddingTop: 24, flexGrow: 1, gap: 0 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          // Inverted: the footer is the top of the feed, the header sits under the latest turn.
          ListFooterComponent={
            <View style={{ gap: 16, paddingBottom: 16 }}>
              {!state.home.away && (stream.connection === "error" || stream.connection === "offline") ? (
                <ConnectionNotice {...stream} />
              ) : null}
              {!snapshot && <ConversationSkeleton />}
              {snapshot && !turns.length && <Notice>This thread is ready for your first message.</Notice>}
            </View>
          }
          renderItem={({ item, index }) => (
            <TimelineTurn
              turn={item}
              entries={entries.get(`${item.fromThreadId}:${item.id}`) ?? []}
              context={context}
              newDay={days.has(item)}
              latest={index === 0}
              onQueued={(turn) => state.setQueued({ turn, editing: false })}
            />
          )}
          ListHeaderComponent={
            <View style={{ gap: 12, paddingBottom: steering.length || loose.length ? 12 : 0 }}>
              <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: c.muted, height: 20 }]}>
                {snapshot && !state.home.away && stream.connection !== "live" ? "Syncing…" : ""}
              </Text>
              {loose.map((n) => (n.notice ? <NoticeRow key={String(n.seq)} notice={n.notice} /> : null))}
              {steering.map((s) => (
                <UserMessageView
                  key={s.id}
                  text={s.text}
                  mentions={s.mentions}
                  note={steeringNote(s)}
                  sender={s.sender}
                  pending
                />
              ))}
            </View>
          }
        />
      </FeedAnchorProvider>
    </TimelineDirectoryProvider>
  );
}
