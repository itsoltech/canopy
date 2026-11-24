import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BackHandler, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ConversationSkeleton, SkeletonScope } from "../../ui/Skeleton";
import { Redirect } from "expo-router";
import { useContextDraft } from "../github/useContextDraft";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { styles, useColors } from "../../ui/theme";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useThreadSnapshot } from "../../state/thread";
import { Notice } from "../../ui/components";
import { ChatKeyboard } from "../composer/ChatKeyboard";
import { MessageComposer } from "./MessageComposer";
import { DropZone } from "../attachments/FileIntake";
import { useOverview } from "../../state/overview";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadTimeline } from "./ThreadTimeline";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { useFollowingList } from "../../ui/useFollowingList";
import { usePersistentMessage } from "../drafts/usePersistentMessage";
import { isFinishedGoal, takesGoals } from "./GoalSheet";
import { useThreadTray } from "./tray/useThreadTray";
import { ThreadTray } from "./tray/ThreadTray";
import { BackgroundTasksChip, runningTasks } from "./tray/BackgroundTasksChip";
import { ThreadSheets } from "./ThreadSheets";
import { useComputerHome } from "../computers/presence";
import { splitId } from "@canopy/domain/computers";
import { FloatingComposer } from "../composer/FloatingComposer";
import { useFloatingComposer } from "../composer/useFloatingComposer";
import { MentionSuggestions } from "../composer/MentionSuggestions";
import { visibleTurns } from "./thread-turns";
import { compactThreadComposerHeight } from "../composer/geometry";
import { ThreadRequests } from "./ThreadRequests";
import { ImportedThreadComposer } from "../imports/ImportedThreadComposer";
import { useQuoteDraft } from "../quotes/useQuoteDraft";
import { useComposerConnection } from "./useComposerConnection";
import { useThreadSend } from "./useThreadSend";
import { useThreadStop } from "./useThreadStop";
import { useMobileOpening } from "../settings/client-diagnostics";
import { threadCacheCurrent } from "@canopy/domain/thread-warm-set";
import { useDevicePreferences } from "../settings/device-preferences";
import { WorkspaceContext } from "../workspace/context";
import { WorkspaceFile } from "../workspace/WorkspaceFile";
import { VisibilityScope } from "../../ui/viewport";
import { WorkspaceModule } from "../workspace/WorkspaceModule";
import { useThreadRewind } from "./useThreadRewind";
import { RewindSheet } from "./RewindSheet";
import { Button } from "../../ui/Button";
import { ArchivedThreadState } from "./ArchivedThreadState";
import { RemovedWorktree } from "./RemovedWorktree";
import { activeReplySource } from "./reply-suggestions";
import { useThreadCreation } from "../new-thread/useThreadCreation";

export type ThreadState = ReturnType<typeof useThreadState>;

function useThreadState(id: string) {
  const { session, client, ready, online, threadCache, workspace: store } = useSession();
  const creation = useThreadCreation(id, true);
  const workspace = store.view(id);
  const threadVisible = useSyncExternalStore(store.subscribe, () => workspace.active === "thread");
  const { snapshot, setSnapshot, stream, history, syncStatus, view } = useThreadSnapshot(id);
  const { warming } = useOverview();
  useMobileOpening(
    id,
    Boolean(threadCache?.peek(id)?.thread),
    Boolean(warming?.enabled && threadCacheCurrent(threadCache?.peek(id), warming.head(id))),
  );
  const following = useFollowingList<ui.Turn>(true, compactThreadComposerHeight, creation?.preparationAnchor?.distance);
  const [details, setDetails] = useState(false);
  const { projects, workers, threads } = useOverview();
  const thread = snapshot?.thread ?? threads.find((t) => t.id === id);
  const message = usePersistentMessage(create(ui.ComposerDraftTargetSchema, { threadId: id }), threadVisible);
  const quotes = useQuoteDraft(undefined, {}, message);

  const { connection, available } = useComposerConnection(
    `${session?.deviceId}:${id}`,
    online && stream.connection === "live",
  );

  const { send, busy, waiting, error, setError, replies } = useThreadSend({
    id,
    message,
    quotes,
    connection,
    sandboxBound: Boolean(thread?.sandboxProfile),
    setSnapshot,
    onSend: following.resumeFollowing,
    replySourceId: activeReplySource(snapshot),
  });

  const { stop, stopping } = useThreadStop(id, snapshot, connection, setError);
  useContextDraft(id, message, setError);

  const archived = Boolean(thread?.archivedAt) || thread?.status === "archived";
  const home = useComputerHome(thread?.nodeId || splitId(id).node);
  const worker = workers.find((w) => w.id === thread?.workerId);
  const tray = useThreadTray({ id, snapshot, setSnapshot, thread, threads });

  const turns = useMemo(() => visibleTurns(snapshot), [snapshot]);

  const rewind = useThreadRewind(
    id,
    message,
    busy || replies.unconfirmed || Boolean(thread?.worktree?.removedAt),
    following.resumeFollowing,
  );

  const hardBlocked =
    home.away ||
    !client ||
    !thread ||
    archived ||
    Boolean(thread.deletedAt || thread.worktree?.removedAt || thread.preparationRequestId) ||
    stream.connection === "error";

  const blocked =
    hardBlocked || busy || replies.unconfirmed || !available || rewind.busy || Boolean(thread?.rewindPending);

  const replyDisabled =
    blocked ||
    !online ||
    stream.connection !== "live" ||
    Boolean(message.persistent?.locked || message.persistent?.reconciling);

  return {
    id,
    session,
    client,
    ready,
    snapshot,
    creation,
    view,
    busy,
    waiting,
    error,
    setError,
    following,
    details,
    setDetails,
    projects,
    stream,
    history,
    syncStatus,
    thread,
    archived,
    worktreeRemoved: Boolean(thread?.worktree?.removedAt),
    worker,
    ...tray,
    turns,
    send: (delivery: ui.MessageDelivery, choices?: Parameters<typeof send>[1]) => {
      if (!blocked) return send(delivery, choices);
    },
    stop,
    stopDisabled: hardBlocked || stopping,
    blocked,
    home,
    message,
    quotes,
    rewind,
    replies: {
      activeId: replyDisabled ? undefined : replies.activeId,
      send: (itemId: string, text: string) => {
        if (!replyDisabled) replies.send(itemId, text);
      },
      unconfirmed: replies.unconfirmed,
      retry: replies.retry,
      retryDisabled:
        hardBlocked ||
        busy ||
        !online ||
        rewind.busy ||
        Boolean(thread?.rewindPending || message.persistent?.locked || message.persistent?.reconciling) ||
        stream.connection !== "live",
    },
  };
}

function useThreadComposer(state: ThreadState) {
  const { message, quotes, following } = state;

  const hasDraft = Boolean(
    message.value.text.length || message.value.mentions.length || message.files.files.length || quotes.quotes.length,
  );

  const composer = useFloatingComposer(following, false, compactThreadComposerHeight, hasDraft);

  return {
    ...composer,
    showLatest: () => {
      if (state.creation) state.creation.preparationAnchor = undefined;
      composer.showLatest();
    },
  };
}

export function ThreadScreen({ id }: { id: string }) {
  const c = useColors();
  const state = useThreadState(id);
  const { viewLoaded } = useDevicePreferences();
  const { warming } = useOverview();
  const { workspace: store } = useSession();
  const workspace = useSyncExternalStore(store.subscribe, () => store.view(id));
  useSyncExternalStore(store.subscribe, () => workspace.active);
  useEffect(() => {
    if (state.thread) store.bindCheckout(workspace, state.thread);
  }, [store, workspace, state.thread]);
  const fileTab = workspace.currentFile;
  const activeTab = workspace.current;
  useEffect(() => {
    warming?.yieldToNavigation();
  }, [warming, workspace.active]);
  useEffect(() => {
    store.touch(workspace);

    return () => workspace.currentFile?.document.cancel();
  }, [store, workspace]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (workspace.active === "thread") return false;
      workspace.select("thread");

      return true;
    });

    return () => subscription.remove();
  }, [workspace]);
  const composer = useThreadComposer(state);

  const [sheet, setSheet] = useState<"goal" | "side" | "files" | "preview" | null>(null);

  const { session, ready, snapshot, following, setDetails, projects, thread, turns, blocked } = state;

  if (!ready) return <ConversationSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  return (
    <WorkspaceContext.Provider value={workspace}>
      <ScreenFrame
        headerBackgroundColor={c.sidebar}
        header={
          <>
            <ThreadHeader
              syncStatus={state.syncStatus}
              history={state.history}
              snapshot={snapshot}
              syncing={Boolean(
                snapshot && !state.home.away && !state.stream.issue && state.stream.connection !== "live",
              )}
              thread={thread}
              project={projects.find((p) => p.id === thread?.projectId)}
              turns={turns.filter((turn) => !turn.rewindId)}
              onDetails={() => {
                setSheet(null);
                setDetails(true);
              }}
              onFiles={() => {
                setDetails(false);
                setSheet("files");
              }}
              onSideThread={() => setSheet("side")}
              onPreview={() => {
                setDetails(false);
                setSheet("preview");
              }}
              onGoal={
                thread && takesGoals(thread) && (!snapshot?.goal || isFinishedGoal(snapshot.goal.status))
                  ? () => setSheet("goal")
                  : undefined
              }
              goalOpen={Boolean(snapshot?.goal && !isFinishedGoal(snapshot.goal.status))}
              readOnly={state.home.away}
            />
            <ConnectionBanner stream={state.stream} />
          </>
        }
      >
        <ChatKeyboard composerHeight={composer.height}>
          <View
            style={[
              { flex: 1 },
              activeTab ? { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0 } : undefined,
            ]}
            pointerEvents={activeTab ? "none" : "auto"}
            accessibilityElementsHidden={Boolean(activeTab)}
            importantForAccessibility={activeTab ? "no-hide-descendants" : "auto"}
          >
            <VisibilityScope visible={!activeTab}>
              <DropZone draft={state.message.files} disabled={blocked || state.home.away}>
                {viewLoaded && <ThreadTimeline state={state} composer={composer} />}
                <FloatingComposer
                  motion={composer.motion}
                  coverage={following.composerInset}
                  resizeInset
                  onLayout={composer.measure}
                  onExpand={composer.expand}
                  onLatest={following.atBottom ? undefined : composer.showLatest}
                  overlay={<ThreadComposerOverlay state={state} />}
                  accessory={<ThreadStatus state={state} />}
                  tray={state.archived ? undefined : <ThreadTray state={state} onGoal={() => setSheet("goal")} />}
                >
                  <ThreadComposer state={state} composer={composer} />
                </FloatingComposer>
              </DropZone>
            </VisibilityScope>
          </View>
          {fileTab && (
            <WorkspaceFile key={`${id}:${fileTab.id}`} view={workspace} tab={fileTab} removed={state.worktreeRemoved} />
          )}
          {activeTab?.kind === "module" && (
            <WorkspaceModule key={`${id}:${activeTab.id}`} state={state} target={activeTab} />
          )}
        </ChatKeyboard>
        <ThreadSheets state={state} sheet={sheet} onClose={() => setSheet(null)} />
        {!state.worktreeRemoved && <RewindSheet state={state.rewind} />}
      </ScreenFrame>
    </WorkspaceContext.Provider>
  );
}

/** What floats above the tray: secrets, delivery issues and running background tasks. */
function ThreadStatus({ state }: { state: ThreadState }) {
  const { home, error } = state;

  if (state.worktreeRemoved) return null;

  return (
    <>
      {!state.archived && <ThreadRequests state={state} />}
      {error ? <Notice error>{error}</Notice> : null}
      {state.thread?.preparationRequestId &&
        (state.thread.status === "creating" ? (
          <Notice>Preparing worktree…</Notice>
        ) : state.thread.status === "failed" ? (
          <Notice error>Worktree setup failed. Return to your draft to try again.</Notice>
        ) : null)}
      {state.replies.unconfirmed && (
        <Button title="Retry" variant="ghost" disabled={state.replies.retryDisabled} onPress={state.replies.retry} />
      )}
      {state.rewind.busy ? <Notice>Editing this thread…</Notice> : null}
      {state.rewind.error && !state.rewind.selected ? <Notice error>{state.rewind.error}</Notice> : null}
      {state.rewind.error && state.rewind.canRetry && !state.rewind.selected ? (
        <Button title="Retry" variant="ghost" onPress={state.rewind.retry} />
      ) : null}
      {state.rewind.saved ? (
        <Button title="Swap saved drafts" variant="ghost" disabled={state.blocked} onPress={state.rewind.swap} />
      ) : null}
      {home.away && (
        <Notice>
          {home.name} · {home.status}. Read only until it reconnects.
        </Notice>
      )}
      <BackgroundTasksChip
        tasks={runningTasks(state.snapshot)}
        threadId={state.thread?.id ?? ""}
        disabled={home.away || state.stream.connection !== "live"}
      />
    </>
  );
}

function ThreadComposer({ state, composer }: { state: ThreadState; composer: ReturnType<typeof useThreadComposer> }) {
  if (state.worktreeRemoved && state.thread) return <RemovedWorktree key={state.thread.id} thread={state.thread} />;

  if (state.archived && state.thread) return <ArchivedThreadState key={state.thread.id} thread={state.thread} />;

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
          send={(delivery, choices) => void state.send(delivery, choices)}
          stop={() => void state.stop()}
          stopDisabled={state.stopDisabled}
          disabled={state.blocked}
          busy={state.busy}
          onDetails={() => state.setDetails(true)}
        />
      </SkeletonScope>
    </ImportedThreadComposer>
  );
}

function ThreadComposerOverlay({ state }: { state: ThreadState }) {
  const { thread, message } = state;
  const c = useColors();

  if (state.archived || state.worktreeRemoved) return null;

  if (state.busy && state.waiting)
    return (
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          bottom: 4,
          right: 0,
          maxWidth: "100%",
          borderRadius: 8,
          backgroundColor: c.surface,
        }}
      >
        <Text
          accessibilityLiveRegion="polite"
          numberOfLines={2}
          style={[styles.meta, { color: c.muted, paddingHorizontal: 8, paddingVertical: 4 }]}
        >
          Still waiting for {state.home.name || "this computer"}…
        </Text>
      </View>
    );

  if (!message.trigger) return null;

  return (
    <MentionSuggestions
      scope={thread ? create(ui.MentionScopeSchema, { threadId: thread.id }) : undefined}
      trigger={message.trigger}
      onPick={(option) => message.pickMention(option.mention)}
    />
  );
}
