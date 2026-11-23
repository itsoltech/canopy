import { useState, type ComponentProps } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { IconButton } from "../../ui/components";
import { useLayout } from "../../state/layout";
import { SidebarToggle } from "../navigation/SidebarToggle";
import { ProjectMark } from "../../ui/ProjectMark";
import { useColors, useTypography } from "../../ui/theme";
import { Skeleton } from "../../ui/Skeleton";
import { ThreadSyncStatus } from "./ThreadSyncStatus";
import { ThreadSyncProgress } from "./ThreadSyncProgress";
import { useWorkspace } from "../workspace/context";
import { WorkspaceTabs } from "../workspace/WorkspaceTabs";

export function ThreadHeaderBar({
  thread,
  project,
  syncing,
  syncStatus,
  onActions,
  onSearch,
  onDetails,
  onFiles,
  onPreview,
  preparingTitle,
}: {
  thread?: ui.Thread;
  preparingTitle?: string;
  project?: ui.Project;
  syncing: boolean;
  syncStatus?: ui.ThreadSyncStatus;
  onActions: () => void;
  onSearch: () => void;
  onDetails: () => void;
  onFiles: () => void;
  onPreview?: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const { wide } = useLayout();
  const workspace = useWorkspace();
  const [expanded, setExpanded] = useState(false);

  return (
    <View
      onLayout={(event) => setExpanded(event.nativeEvent.layout.width >= 600)}
      style={[s.bar, { backgroundColor: c.sidebar }]}
    >
      {wide ? (
        <View style={s.action}>
          <SidebarToggle />
        </View>
      ) : (
        <HeaderAction
          icon="chevron-left"
          label="Back to threads"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
      )}
      {project && (
        <View accessible accessibilityRole="image" accessibilityLabel={project.name} style={s.project}>
          <ThreadSyncStatus key={thread?.id} syncing={syncing}>
            <ProjectMark name={project.name} color={project.color} kind={project.kind} />
          </ThreadSyncStatus>
        </View>
      )}
      {workspace ? (
        <WorkspaceTabs
          view={workspace}
          title={thread?.title ?? "Thread"}
          loading={!thread}
          expanded={expanded}
          onThreadActions={onActions}
        />
      ) : (
        <View style={[s.identity, { backgroundColor: c.background }]}>
          {thread || preparingTitle ? (
            <Text
              numberOfLines={1}
              accessibilityLabel={thread?.title ?? preparingTitle}
              style={[type.chrome, { color: c.text }]}
            >
              {thread?.title ?? preparingTitle}
            </Text>
          ) : (
            <Skeleton style={{ width: "80%", height: 16 }} />
          )}
        </View>
      )}
      <ThreadSyncProgress status={syncStatus} compact />
      {expanded && (
        <HeaderAction
          icon="magnifying-glass"
          label="Search thread"
          disabled={Boolean(preparingTitle)}
          onPress={onSearch}
        />
      )}
      {((!workspace && !preparingTitle) || expanded) && (
        <HeaderAction icon="ellipsis-horizontal" label="Thread actions" disabled={!thread} onPress={onActions} />
      )}
      <HeaderAction
        icon="information-circle"
        label="Thread details"
        disabled={Boolean(preparingTitle)}
        onPress={onDetails}
      />
      <HeaderAction
        icon="folder"
        label="Files"
        disabled={Boolean(preparingTitle || thread?.worktree?.removedAt)}
        onPress={onFiles}
      />
      {onPreview && (
        <HeaderAction
          icon="eye"
          label="Open preview"
          disabled={Boolean(preparingTitle || thread?.worktree?.removedAt)}
          onPress={onPreview}
        />
      )}
    </View>
  );
}

function HeaderAction(props: ComponentProps<typeof IconButton>) {
  return (
    <View style={s.action}>
      <IconButton {...props} />
    </View>
  );
}

const s = StyleSheet.create({
  bar: { minHeight: 52, flexDirection: "row", alignItems: "center", paddingTop: 4, paddingHorizontal: 4 },
  action: { width: 48, height: 48, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  project: { width: 26, flexShrink: 0, paddingRight: 8 },
  identity: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    paddingHorizontal: 8,
    justifyContent: "center",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
});
