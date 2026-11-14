import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BackHandler, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ConversationSkeleton, SkeletonScope } from "../../ui/Skeleton";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useContextDraft } from "../github/useContextDraft";
import { ScreenFrame } from "../../ui/ScreenFrame";
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
import { threadComposerHeight } from "../composer/geometry";
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

export type ThreadState = ReturnType<typeof useThreadState>;

function useThreadState(id: string) {
  const { session, client, ready, online, threadCache, workspace: store } = useSession();
  const workspace = store.view(id);
  const threadVisible = useSyncExternalStore(store.subscribe, () => workspace.active === "thread");
  const { snapshot, setSnapshot, stream, history, syncStatus, view } = useThreadSnapshot(id);
  const { warming } = useOverview();
  useMobileOpening(
    id,
    Boolean(threadCache?.peek(id)?.thread),
    Boolean(warming?.enabled && threadCacheCurrent(threadCache?.peek(id), warming.head(id))),
  );
  const following = useFollowingList<ui.Turn>(true, threadComposerHeight);
  const [details, setDetails] = useState(false);
  const { projects, workers, threads } = useOverview();
  const message = usePersistentMessage(create(ui.ComposerDraftTargetSchema, { threadId: id }), threadVisible);
  const quotes = useQuoteDraft(undefined, {}, message);

  const { connection, available } = useComposerConnection(
    `${session?.deviceId}:${id}`,
    online && stream.connection === "live",
  );

  const { send, busy, waiting, error, setError } = useThreadSend({
    id,
    message,
    quotes,
    connection,
    setSnapshot,
    onSend: following.resumeFollowing,
  });

  const { stop, stopping } = useThreadStop(id, snapshot, connection, setError);
  useContextDraft(id, message, setError);

  const thread = snapshot?.thread ?? threads.find((t) => t.id === id);
  const home = useComputerHome(thread?.nodeId || splitId(id).node);
  const worker = workers.find((w) => w.id === thread?.workerId);
  const tray = useThreadTray({ id, snapshot, setSnapshot, thread, threads });

  const turns = useMemo(() => visibleTurns(snapshot), [snapshot]);
  const rewind = useThreadRewind(id, message, busy, following.resumeFollowing);

  const hardBlocked =
    home.away ||
    !client ||
    !thread ||
    Boolean(thread.archivedAt || thread.deletedAt) ||
    thread.status === "archived" ||
    stream.connection === "error";

  const blocked = hardBlocked || busy || !available || rewind.busy || Boolean(thread?.rewindPending);

  return {
    id,
    session,
    client,
    ready,
    snapshot,
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
    worker,
    ...tray,
    turns,
    send,
    stop,
    stopDisabled: hardBlocked || stopping,
    blocked,
    home,
    message,
    quotes,
    rewind,
  };
}

/** Pending drafts can fold into their summary; an open mention list or synchronous question stays open. */
function useThreadComposer(state: ThreadState) {
  const { message, interactions } = state;

  return useFloatingComposer(
    state.following,
    Boolean(message.trigger) || interactions.some((i) => i.kind === InteractionKind.QUESTION && !i.asynchronous),
    threadComposerHeight,
  );
}

export function ThreadScreen({ id }: { id: string }) {
  const state = useThreadState(id);
  const { viewLoaded } = useDevicePreferences();
  const { warming } = useOverview();
  const { workspace: store } = useSession();
  const workspace = useSyncExternalStore(store.subscribe, () => store.view(id));
  useSyncExternalStore(store.subscribe, () => workspace.active);
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

  const [sheet, setSheet] = useState<"goal" | "side" | "files" | null>(null);
  const params = useLocalSearchParams<{ draftSideThread?: string }>();
  useEffect(() => {
    if (params.draftSideThread === "1") {
      setSheet("side");
      router.setParams({ draftSideThread: undefined });
    }
  }, [params.draftSideThread]);

  const { session, ready, snapshot, following, setDetails, projects, thread, turns, blocked } = state;

  const { atBottom } = following;

  if (!ready) return <ConversationSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  return (
    <WorkspaceContext.Provider value={workspace}>
      <ScreenFrame
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
                  onLayout={composer.measure}
                  onExpand={composer.expand}
                  onLatest={atBottom ? undefined : composer.showLatest}
                  overlay={<ThreadSuggestions state={state} />}
                  accessory={<ThreadStatus state={state} />}
                  tray={<ThreadTray state={state} onGoal={() => setSheet("goal")} />}
                >
                  <ThreadComposer state={state} composer={composer} />
                </FloatingComposer>
              </DropZone>
            </VisibilityScope>
          </View>
          {fileTab && <WorkspaceFile key={`${id}:${fileTab.id}`} view={workspace} tab={fileTab} />}
          {activeTab?.kind === "module" && (
            <WorkspaceModule key={`${id}:${activeTab.id}`} state={state} target={activeTab} />
          )}
        </ChatKeyboard>
        <ThreadSheets state={state} sheet={sheet} onClose={() => setSheet(null)} />
        <RewindSheet state={state.rewind} />
      </ScreenFrame>
    </WorkspaceContext.Provider>
  );
}

/** What floats above the tray: secrets, sending and delivery notes, and running background tasks. */
function ThreadStatus({ state }: { state: ThreadState }) {
  const { home, error } = state;

  return (
    <>
      <ThreadRequests state={state} />
      {state.busy ? (
        <Notice>{state.waiting ? `Still waiting for ${home.name || "this computer"}…` : "Sending…"}</Notice>
      ) : null}
      {error ? <Notice error>{error}</Notice> : null}
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

function ThreadSuggestions({ state }: { state: ThreadState }) {
  const { thread, message } = state;

  if (!message.trigger) return null;

  return (
    <MentionSuggestions
      scope={thread ? create(ui.MentionScopeSchema, { threadId: thread.id }) : undefined}
      trigger={message.trigger}
      onPick={(option) => message.pickMention(option.mention)}
    />
  );
}
