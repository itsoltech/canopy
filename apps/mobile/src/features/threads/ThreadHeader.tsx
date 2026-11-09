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

export function ThreadHeader({
  thread,
  project,
  turns,
  snapshot,
  onDetails,
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
  onDetails: () => void;
  onSideThread: () => void;
  onGoal?: () => void;
  goalOpen: boolean;
  readOnly?: boolean;
  history: { loading: boolean; error: string; load: () => Promise<void> };
}) {
  const c = useColors();
  const { wide } = useLayout();
  const [sheet, setSheet] = useState<"actions" | "search" | null>(null);

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
        <ThreadIdentity thread={thread} project={project} />
        <IconButton icon="magnifying-glass" label="Search thread" onPress={() => setSheet("search")} />
        <IconButton
          icon="ellipsis-horizontal"
          label="Thread actions"
          disabled={readOnly || !thread}
          onPress={() => setSheet("actions")}
        />
        <IconButton icon="view-columns" label="Thread details" onPress={onDetails} />
      </View>
      {thread && (
        <ThreadActionsSheet
          thread={thread}
          visible={!readOnly && sheet === "actions"}
          onClose={() => setSheet(null)}
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
        hasMore={snapshot?.historyHasMore ?? false}
      />
    </>
  );
}

function ThreadIdentity({ thread, project }: { thread?: ui.Thread; project?: ui.Project }) {
  const c = useColors();

  return (
    <>
      {project && <ProjectMark name={project.name} kind={project.kind} />}
      {project ? (
        <Text numberOfLines={1} style={[styles.body, { color: c.muted, maxWidth: 110, paddingLeft: 8 }]}>
          {project.name}
        </Text>
      ) : (
        <Skeleton style={{ width: 70, height: 16 }} />
      )}
      <Text style={[styles.body, { color: c.faint, paddingHorizontal: 8 }]}>/</Text>
      <View style={{ flex: 1 }}>
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
