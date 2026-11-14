import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { IconButton } from "../../ui/components";
import { useLayout } from "../../state/layout";
import { SidebarToggle } from "../navigation/SidebarToggle";
import { ProjectMark } from "../../ui/ProjectMark";
import { styles, useColors } from "../../ui/theme";
import { Skeleton } from "../../ui/Skeleton";
import { ThreadSearchSheet } from "./ThreadSearchSheet";
import { ThreadActionsSheet } from "./ThreadActionsSheet";
import { ThreadSyncStatus } from "./ThreadSyncStatus";
import { ThreadSyncProgress } from "./ThreadSyncProgress";
import { useWorkspace } from "../workspace/context";
import { WorkspaceTabs } from "../workspace/WorkspaceTabs";

export function ThreadHeader({
  thread,
  project,
  turns,
  snapshot,
  syncing,
  syncStatus,
  onDetails,
  onFiles,
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
  onSideThread: () => void;
  onGoal?: () => void;
  goalOpen: boolean;
  readOnly?: boolean;
  history: { loading: boolean; error: string; load: () => Promise<void> };
}) {
  const c = useColors();
  const { wide } = useLayout();
  const [sheet, setSheet] = useState<"actions" | "search" | null>(null);
  const workspace = useWorkspace();

  return (
    <>
      <View
        style={[
          styles.row,
          { height: 48, paddingHorizontal: 4, gap: 0, borderBottomWidth: 1, borderBottomColor: c.line },
        ]}
      >
        {wide ? (
          <SidebarToggle />
        ) : (
          <IconButton
            icon="bars-3"
            label="Threads"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          />
        )}
        <ThreadIdentity thread={thread} project={project} syncing={syncing} />
        {workspace && <WorkspaceTabs view={workspace} onThreadActions={() => setSheet("actions")} />}
        <ThreadSyncProgress status={syncStatus} compact={Boolean(workspace)} />
        {wide && <IconButton icon="magnifying-glass" label="Search thread" onPress={() => setSheet("search")} />}
        {!workspace && (
          <IconButton
            icon="ellipsis-horizontal"
            label="Thread actions"
            disabled={!thread}
            onPress={() => setSheet("actions")}
          />
        )}
        <IconButton icon="information-circle" label="Thread details" onPress={onDetails} />
        <IconButton icon="folder" label="Files" onPress={onFiles} />
      </View>
      {thread && (
        <ThreadActionsSheet
          thread={thread}
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

function ThreadIdentity({ thread, project, syncing }: { thread?: ui.Thread; project?: ui.Project; syncing: boolean }) {
  const c = useColors();

  return (
    <>
      {project && (
        <ThreadSyncStatus key={thread?.id} syncing={syncing}>
          <ProjectMark name={project.name} kind={project.kind} />
        </ThreadSyncStatus>
      )}
      <View style={{ flex: 1, minWidth: 0, maxWidth: 110, paddingLeft: 8 }}>
        {thread ? (
          <Text numberOfLines={1} style={[styles.body, { color: c.text }]}>
            {thread.title}
          </Text>
        ) : (
          <Skeleton style={{ width: "80%", height: 16 }} />
        )}
      </View>
    </>
  );
}
