import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ConversationSkeleton, SkeletonScope } from "../../ui/Skeleton";
import { Redirect } from "expo-router";
import { ScreenFrame } from "../../ui/ScreenFrame";
import * as Crypto from "expo-crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { InteractionKind, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useThreadSnapshot } from "../../state/thread";
import { Notice } from "../../ui/components";
import { ChatKeyboard } from "../composer/ChatKeyboard";
import { MessageComposer } from "./MessageComposer";
import { DropZone } from "../attachments/FileIntake";
import { useOverview } from "../../state/overview";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadTimeline } from "./ThreadTimeline";
import { ThreadSyncStatus } from "./ThreadSyncStatus";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { SubagentPanel } from "./SubagentPanel";
import { useFollowingList } from "../../ui/useFollowingList";
import { useMessageDraft } from "../composer/useMessageDraft";
import { isFinishedGoal, takesGoals } from "./GoalSheet";
import { ThreadSheets } from "./ThreadSheets";
import { useComputerHome } from "../computers/presence";
import { splitId } from "@canopy/domain/computers";
import { FloatingComposer } from "../composer/FloatingComposer";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { MentionSuggestions } from "../composer/MentionSuggestions";
import { visibleTurns } from "./thread-turns";
import { threadComposerHeight } from "../composer/geometry";
import { ThreadRequests } from "./ThreadRequests";
import { ImportedThreadComposer } from "../imports/ImportedThreadComposer";
import { useQuoteDraft } from "../quotes/useQuoteDraft";
import { withSentMessage } from "./sent-message";

/** The gateway refused the message and says why (not delivered: no retry note); otherwise delivery is unknown. */
function deliveryError(failure: ConnectError) {
  return [Code.InvalidArgument, Code.FailedPrecondition, Code.ResourceExhausted].includes(failure.code)
    ? failure.rawMessage
    : "Could not confirm delivery. Retry with the same text to send it only once.";
}

export type ThreadState = ReturnType<typeof useThreadState>;

function useThreadState(id: string) {
  const { session, client, ready, online, expired } = useSession();
  const { snapshot, setSnapshot, stream, history, usage } = useThreadSnapshot(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const following = useFollowingList<ui.Turn>(true);
  const [details, setDetails] = useState(false);
  const [queued, setQueued] = useState<{ turn: ui.Turn; editing: boolean }>();
  const { projects, workers, threads } = useOverview();
  const sending = useRef(false);
  const message = useMessageDraft();
  const quotes = useQuoteDraft();

  const pending = useRef<{
    key: string;
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

  async function send(delivery: ui.MessageDelivery) {
    const outgoing = message.outgoing();
    const { text: value, attachmentIds, mentions } = outgoing;

    if (
      !client ||
      (!value && !attachmentIds.length && !quotes.quotes.length) ||
      message.files.blocker ||
      sending.current
    )
      return;
    sending.current = true;
    following.resumeFollowing();
    setBusy(true);
    setError("");

    const key = JSON.stringify({ value, delivery, attachmentIds, mentions, quotes: quotes.quotes });

    if (pending.current?.key !== key) pending.current = { key, id: Crypto.randomUUID() };

    try {
      const result = await client.api.sendMessage(
        {
          threadId: id,
          text: value,
          delivery,
          attachmentIds,
          mentions,
          quotes: [...quotes.quotes],
          clientRequestId: pending.current.id,
        },
        { signal: requestController.current.signal, timeoutMs: 20_000 },
      );

      setSnapshot((snapshot) => withSentMessage(snapshot, result));
      message.clear();
      quotes.clear();

      if (result.deliveryNote) setError(result.deliveryNote);
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
    usage,
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
    quotes,
    queued,
    setQueued,
  };
}

/** The thread's floating composer: a draft, files, a mention list or a synchronous question keep it open. */
function useThreadComposer(state: ThreadState) {
  const { message, interactions } = state;

  return useFloatingComposer(
    state.following,
    Boolean(message.value.text.length || message.files.files.length || message.trigger || state.quotes.quotes.length) ||
      interactions.some((i) => i.kind === InteractionKind.QUESTION && !i.asynchronous),
    threadComposerHeight,
  );
}

export function ThreadScreen({ id }: { id: string }) {
  const state = useThreadState(id);
  const composer = useThreadComposer(state);

  const [sheet, setSheet] = useState<"goal" | "side" | null>(null);

  const { session, ready, snapshot, error, following, setDetails, projects, thread, turns, blocked } = state;

  const { atBottom } = following;

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
            onGoal={
              thread && takesGoals(thread) && (!snapshot?.goal || isFinishedGoal(snapshot.goal.status))
                ? () => setSheet("goal")
                : undefined
            }
            goalOpen={Boolean(snapshot?.goal && !isFinishedGoal(snapshot.goal.status))}
            readOnly={state.home.away}
          />
          <ConnectionBanner stream={state.home.away ? undefined : state.stream} />
        </>
      }
    >
      <ChatKeyboard composerHeight={composer.height}>
        <DropZone draft={state.message.files} disabled={blocked || state.home.away}>
          <ThreadTimeline state={state} composer={composer} />
          <FloatingComposer
            motion={composer.motion}
            onLayout={composer.measure}
            onExpand={composer.expand}
            onLatest={atBottom ? undefined : composer.showLatest}
            overlay={<ThreadSuggestions state={state} />}
            accessory={
              <>
                <ThreadSyncStatus state={state} />
                <ThreadRequests state={state} />
              </>
            }
          >
            {error ? <Notice error>{error}</Notice> : null}
            {state.home.away && (
              <Notice>
                {state.home.name} · {state.home.status}. Read only until it reconnects.
              </Notice>
            )}
            <ThreadComposer state={state} composer={composer} onGoal={() => setSheet("goal")} />
          </FloatingComposer>
        </DropZone>
      </ChatKeyboard>
      <ThreadSheets state={state} sheet={sheet} onClose={() => setSheet(null)} />
    </ScreenFrame>
  );
}

function ThreadComposer({
  state,
  composer,
  onGoal,
}: {
  state: ThreadState;
  composer: ReturnType<typeof useThreadComposer>;
  onGoal: () => void;
}) {
  return (
    <ImportedThreadComposer thread={state.thread} disabled={state.blocked}>
      <SkeletonScope loading={!state.thread}>
        <MessageComposer
          compact={composer.compact}
          onExpand={composer.expand}
          thread={state.thread}
          worker={state.worker}
          message={state.message}
          quotes={state.quotes}
          send={(delivery) => void state.send(delivery)}
          stop={() => {
            if (!state.client || !state.thread) return;
            void state.client.api
              .interruptThread({ threadId: state.thread.id })
              .catch(() => state.setError("Could not stop the turn. Try again."));
          }}
          disabled={state.blocked}
          busy={state.busy}
          onDetails={() => state.setDetails(true)}
          onGoal={onGoal}
        />
      </SkeletonScope>
    </ImportedThreadComposer>
  );
}

function ThreadSuggestions({ state }: { state: ThreadState }) {
  const { thread, message } = state;

  // A typed trigger temporarily takes the same overlay slot; the remembered subagent choice stays intact.
  if (!message.trigger) return <SubagentPanel threads={state.subagents} />;

  return (
    <MentionSuggestions
      scope={thread ? create(ui.MentionScopeSchema, { threadId: thread.id }) : undefined}
      trigger={message.trigger}
      onPick={(option) => message.pickMention(option.mention)}
    />
  );
}
