import { useEffect, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { ConversationSkeleton, SkeletonScope } from "../../ui/Skeleton";
import { Redirect } from "expo-router";
import { ScreenFrame } from "../../ui/ScreenFrame";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { InteractionKind, ui } from "@canopy/contracts";
import { applyThread } from "../../api/thread";
import { useSession } from "../../state/session";
import { useThreadSnapshot } from "../../state/thread";
import { Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { MessageComposer } from "./MessageComposer";
import { DropZone } from "../attachments/FileIntake";
import { ThreadPanel } from "./ThreadPanel";
import { InteractionCard } from "./InteractionCard";
import { useOverview } from "../../state/overview";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadTimeline } from "./ThreadTimeline";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { SubagentStrip } from "./SubagentStrip";
import { useFollowingList } from "../../ui/useFollowingList";
import { useMessageDraft } from "../composer/useMessageDraft";
import { QueuedMessageMenu, QueueEditor } from "./QueuedMessage";
import { GoalSheet, isFinishedGoal, takesGoals } from "./GoalSheet";
import { SideThreadSheet } from "./SideThreadSheet";
import { useComputerHome } from "../computers/presence";
import { splitId } from "@canopy/domain/computers";
import { FloatingComposer } from "../composer/FloatingComposer";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { MentionSuggestions } from "../composer/MentionSuggestions";
import { visibleTurns } from "./thread-turns";
import { SubagentSheet } from "./SubagentSheet";

/** The gateway refused the message and says why (not delivered: no retry note); otherwise delivery is unknown. */
function deliveryError(failure: ConnectError) {
  return [Code.InvalidArgument, Code.FailedPrecondition, Code.ResourceExhausted].includes(failure.code)
    ? failure.rawMessage
    : "Could not confirm delivery. Retry with the same text to send it only once.";
}

export type ThreadState = ReturnType<typeof useThreadState>;

function useThreadState(id: string) {
  const { session, client, ready, online, expired } = useSession();
  const { snapshot, setSnapshot, stream, history } = useThreadSnapshot(id);
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
  const subagents = threads.filter((t) => t.spawnedByAgent && t.parentThreadId === id && !t.deletedAt);
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
    history,
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

/** The thread's floating composer: a draft, files, a mention list or a synchronous question keep it open. */
function useThreadComposer(state: ThreadState) {
  const { message, interactions } = state;

  return useFloatingComposer(
    state.following,
    Boolean(message.value.text.length || message.files.files.length || message.trigger) ||
      interactions.some((i) => i.kind === InteractionKind.QUESTION && !i.asynchronous),
  );
}

export function ThreadScreen({ id }: { id: string }) {
  const c = useColors();
  const state = useThreadState(id);
  const composer = useThreadComposer(state);

  const [sheet, setSheet] = useState<"goal" | "side" | "subagents" | null>(null);
  const { pop } = useMotion();

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
    <ScreenFrame
      header={
        <>
          <ThreadHeader
            history={state.history}
            snapshot={snapshot}
            thread={thread}
            project={projects.find((p) => p.id === thread?.projectId)}
            turns={turns}
            onDetails={() => setDetails(true)}
            onSideThread={() => setSheet("side")}
            onGoal={thread && takesGoals(thread) ? () => setSheet("goal") : undefined}
            goalOpen={Boolean(snapshot?.goal && !isFinishedGoal(snapshot.goal.status))}
            readOnly={state.home.away}
          />
          <ConnectionBanner stream={state.home.away ? undefined : state.stream} />
        </>
      }
    >
      <KeyboardArea>
        <DropZone draft={state.message.files} disabled={blocked || state.home.away}>
          <ThreadTimeline state={state} composer={composer} />
          <FloatingComposer
            motion={composer.motion}
            onLayout={composer.measure}
            onExpand={composer.expand}
            onLatest={atBottom ? undefined : showLatest}
            overlay={<ThreadSuggestions state={state} />}
          >
            {error ? <Notice error>{error}</Notice> : null}
            {state.home.away && (
              <Notice>
                {state.home.name} · {state.home.status}. Read only until it reconnects.
              </Notice>
            )}
            {!state.home.away &&
              interactions.slice(0, 1).map((i) => (
                // A request pops in; once answered (here or elsewhere) it leaves the same way.
                <Animated.View key={i.requestId} entering={pop.entering} exiting={pop.exiting}>
                  <InteractionCard interaction={i} />
                </Animated.View>
              ))}
            {interactions.length > 1 && (
              <Text style={[styles.meta, { color: c.warning }]}>+{interactions.length - 1} pending</Text>
            )}
            <SubagentStrip subagents={subagents} onFinished={() => setSheet("subagents")} />
            <SkeletonScope loading={!thread}>
              <MessageComposer
                compact={composer.compact}
                onExpand={composer.expand}
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
          </FloatingComposer>
        </DropZone>
      </KeyboardArea>
      <ThreadPanel snapshot={snapshot} visible={details} onClose={() => setDetails(false)} />
      <SubagentSheet threads={subagents} visible={sheet === "subagents"} onClose={() => setSheet(null)} />
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
    </ScreenFrame>
  );
}

function ThreadSuggestions({ state }: { state: ThreadState }) {
  const { thread, message } = state;

  return (
    <MentionSuggestions
      scope={thread ? create(ui.MentionScopeSchema, { threadId: thread.id }) : undefined}
      trigger={message.trigger}
      onPick={(option) => message.pickMention(option.mention)}
    />
  );
}
