import { ThreadPanel } from "./ThreadPanel";
import { GoalSheet } from "./GoalSheet";
import { SideThreadSheet } from "./SideThreadSheet";
import { QueueEditor } from "./QueuedMessage";
import { QueuedMessageMenu } from "./QueuedMessageMenu";
import type { ThreadState } from "./ThreadScreen";
import { TimelineDirectoryProvider, type TimelineDirectory } from "../timeline/directory";

export function ThreadSheets({
  state,
  sheet,
  onClose,
}: {
  state: ThreadState;
  sheet: "goal" | "side" | null;
  onClose: () => void;
}) {
  const { snapshot, thread } = state;

  return (
    <>
      <TimelineDirectoryProvider value={viewerDirectory(state)}>
        <ThreadPanel snapshot={snapshot} visible={state.details} onClose={() => state.setDetails(false)} />
      </TimelineDirectoryProvider>
      <QueuedMessageMenu
        threadId={thread?.id ?? ""}
        turns={snapshot?.turns ?? []}
        running={snapshot?.turns.some((t) => !t.inherited && t.status === "running") ?? false}
        disabled={state.home.away || state.stream.connection !== "live"}
        turn={state.home.away || state.queued?.editing ? undefined : state.queued?.turn}
        onClose={() => state.setQueued(undefined)}
        onEdit={(turn) => state.setQueued({ turn, editing: true })}
        onError={state.setError}
      />
      <GoalSheet
        thread={thread}
        goal={snapshot?.goal}
        visible={!state.home.away && sheet === "goal"}
        onClose={onClose}
      />
      <SideThreadSheet main={thread} visible={!state.home.away && sheet === "side"} onClose={onClose} />
      <QueueEditor
        turn={!state.home.away && state.queued?.editing ? state.queued.turn : undefined}
        onClose={() => state.setQueued(undefined)}
      />
    </>
  );
}

function viewerDirectory(state: ThreadState): TimelineDirectory {
  const { thread, snapshot } = state;

  return {
    currentId: thread?.id ?? "",
    quote: state.quotes.add,
    readOnly: state.home.away || !thread || Boolean(thread.archivedAt || thread.deletedAt),
    thread: (id) => (id === thread?.id ? thread : undefined),
    item: (id) => snapshot?.items.find((entry) => entry.item?.itemId === id)?.item,
    delivery: (id) => snapshot?.busDeliveries.find((delivery) => delivery.callId === id),
  };
}
