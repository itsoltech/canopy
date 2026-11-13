import { ItemStatus } from "@canopy/contracts";
import { backgroundTitle } from "@canopy/domain/background-tasks";
import type { ThreadState } from "../threads/ThreadScreen";
import { BackgroundTaskStop } from "../threads/BackgroundTaskStop";
import { TextViewer } from "../viewers/TextViewer";
import { QuoteItem } from "../quotes/QuoteAction";
import { Notice } from "../../ui/components";

export function WorkspaceTask({ state, id }: { state: ThreadState; id: string }) {
  const item = state.snapshot?.items.find((entry) => entry.item?.itemId === id)?.item;

  if (item?.content.case !== "backgroundTask")
    return <Notice>This task is outside the loaded history. Open Tasks to choose another task.</Notice>;
  const task = item.content.value;

  return (
    <QuoteItem.Provider value={item.itemId}>
      <TextViewer
        embedded
        text={task.output}
        blob={task.outputBlob}
        threadId={state.thread?.id ?? ""}
        label={backgroundTitle(task, "Task output")}
        onClose={() => undefined}
        extraActions={
          item.status === ItemStatus.IN_PROGRESS && (
            <BackgroundTaskStop
              threadId={state.thread?.id ?? ""}
              itemId={item.itemId}
              disabled={state.home.away || state.stream.connection !== "live"}
            />
          )
        }
      />
    </QuoteItem.Provider>
  );
}
