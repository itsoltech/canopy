import { ThreadPanel } from "./ThreadPanel";
import { GoalSheet } from "./GoalSheet";
import { SideThreadSheet } from "./SideThreadSheet";
import { QueueEditor } from "./QueuedMessage";
import type { ThreadState } from "./ThreadScreen";
import { TimelineDirectoryProvider, type TimelineDirectory } from "../timeline/directory";
import { PreviewSheet } from "../preview/PreviewSheet";
import { WorkspaceFiles } from "../workspace/WorkspaceFiles";

export function ThreadSheets({
  state,
  sheet,
  onClose,
}: {
  state: ThreadState;
  sheet: "goal" | "side" | "files" | "preview" | null;
  onClose: () => void;
}) {
  const { snapshot, thread } = state;

  return (
    <>
      <TimelineDirectoryProvider value={viewerDirectory(state)}>
        <ThreadPanel
          snapshot={snapshot}
          syncStatus={state.syncStatus}
          visible={state.details}
          onClose={() => state.setDetails(false)}
        />
      </TimelineDirectoryProvider>
      <GoalSheet
        thread={thread}
        goal={snapshot?.goal}
        visible={!state.home.away && !state.worktreeRemoved && sheet === "goal"}
        onClose={onClose}
      />
      <PreviewSheet
        threadId={state.id}
        worker={state.worker}
        visible={!state.worktreeRemoved && sheet === "preview"}
        offline={state.home.away || Boolean(thread?.archivedAt || thread?.deletedAt)}
        onClose={onClose}
      />
      <WorkspaceFiles visible={!state.worktreeRemoved && sheet === "files"} onClose={onClose} />
      <SideThreadSheet
        main={thread}
        visible={!state.home.away && !state.worktreeRemoved && sheet === "side"}
        onClose={onClose}
      />
      <QueueEditor
        turn={state.home.away || state.worktreeRemoved ? undefined : state.editing}
        onClose={() => state.setEditing(undefined)}
      />
    </>
  );
}

function viewerDirectory(state: ThreadState): TimelineDirectory {
  const { thread, snapshot } = state;

  return {
    currentId: thread?.id ?? "",
    quote: state.quotes.add,
    readOnly:
      state.home.away || !thread || Boolean(thread.archivedAt || thread.deletedAt || thread.worktree?.removedAt),
    thread: (id) => (id === thread?.id ? thread : undefined),
    item: (id) => snapshot?.items.find((entry) => entry.item?.itemId === id)?.item,
    delivery: (id) => snapshot?.busDeliveries.find((delivery) => delivery.callId === id),
  };
}
