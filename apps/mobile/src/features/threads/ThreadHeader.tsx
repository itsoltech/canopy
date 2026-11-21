import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { ThreadSearchSheet } from "./ThreadSearchSheet";
import { ThreadActionsSheet } from "./ThreadActionsSheet";
import { ThreadHeaderBar } from "./ThreadHeaderBar";

export function ThreadHeader({
  thread,
  project,
  turns,
  snapshot,
  syncing,
  syncStatus,
  onDetails,
  onFiles,
  onPreview,
  onSideThread,
  onGoal,
  goalOpen,
  readOnly = false,
  history,
}: {
  thread?: ui.Thread;
  project?: ui.Project;
  turns: ui.Turn[];
  snapshot?: ui.ThreadSnapshot;
  syncing: boolean;
  syncStatus?: ui.ThreadSyncStatus;
  onDetails: () => void;
  onFiles: () => void;
  onPreview?: () => void;
  onSideThread: () => void;
  onGoal?: () => void;
  goalOpen: boolean;
  readOnly?: boolean;
  history: { loading: boolean; error: string; load: () => Promise<void> };
}) {
  const [sheet, setSheet] = useState<"actions" | "search" | null>(null);
  const { threads } = useOverview();
  const sidebar = threads.find((row) => row.id === thread?.id);

  const actionThread =
    thread && sidebar ? { ...thread, snoozed: sidebar.snoozed, snoozedUntil: sidebar.snoozedUntil } : thread;

  return (
    <>
      <ThreadHeaderBar
        thread={thread}
        project={project}
        syncing={syncing}
        syncStatus={syncStatus}
        onActions={() => setSheet("actions")}
        onSearch={() => setSheet("search")}
        onDetails={onDetails}
        onFiles={onFiles}
        onPreview={onPreview}
      />
      {actionThread && (
        <ThreadActionsSheet
          thread={actionThread}
          visible={sheet === "actions"}
          onClose={() => setSheet(null)}
          onSearch={() => setSheet("search")}
          readOnly={readOnly}
          onSideThread={onSideThread}
          onGoal={onGoal}
          goalOpen={goalOpen}
        />
      )}
      <ThreadSearchSheet
        visible={sheet === "search"}
        turns={turns}
        items={snapshot?.items ?? []}
        onClose={() => setSheet(null)}
        history={history}
        hasMore={Boolean(snapshot?.historyHasMore || snapshot?.historyItemsHasMore)}
      />
    </>
  );
}
