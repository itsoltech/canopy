import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useState } from "react";
import { ThreadActionsSheet } from "../threads/ThreadActionsSheet";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { ui } from "@canopy/contracts";
import { threadRowMarks } from "@canopy/ui/thread-row";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { useOverview } from "../../state/overview";
import { styles, useColors } from "../../ui/theme";
import { Swap } from "../../ui/MotionViews";
import { isCalm, needsYou, threadRowLabel, workState } from "@canopy/domain/thread-activity";
import { threadRowPlace } from "@canopy/domain/git-heads";
import { threadPullRequestBadge } from "@canopy/domain/github-pr";
import { useComputerHome } from "../computers/presence";
import { SidebarUnread } from "./SidebarUnread";
import { useSidebarTypography } from "./sidebar-scale";
import { SidebarActivity } from "./SidebarActivity";
import { SidebarThreadStatus } from "./SidebarThreadStatus";
import { IconButton } from "../../ui/components";
import { useSidebarDragContext } from "./sidebar-drag";
import { DraftMarker } from "../drafts/DraftMarker";
import { SidebarThreadMeta, SidebarThreadMarks } from "./SidebarThreadMeta";

const rowStyle: ViewStyle = {
  paddingHorizontal: 12,
  minHeight: 48,
  paddingVertical: 8,
  justifyContent: "center",
  gap: 2,
  borderRadius: 12,
  borderWidth: 1,
};

interface SidebarThreadProps {
  thread: ui.Thread;
  project?: ui.Project;
  worker?: ui.Worker;
  style?: StyleProp<ViewStyle>;
  subagentsNeedingInput?: readonly ui.Thread[];
  reorder?: boolean;
  groupedProject?: boolean;
  groupedWorktree?: boolean;
}

export function SidebarThread(props: SidebarThreadProps) {
  const { thread, project, style, subagentsNeedingInput = [], reorder = false } = props;
  const c = useColors();
  const [actions, setActions] = useState(false);
  const ordering = useSidebarDragContext();
  const home = useComputerHome(thread.nodeId);
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  // Wide windows show the open thread beside the list: mark it.
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;
  const needs = !home.away && (needsYou(thread) || subagentsNeedingInput.length > 0);
  const place = threadRowPlace(thread, project);
  const pullRequests = threadPullRequestBadge(thread);

  const statusLabel = home.away
    ? "Read-only"
    : !needsYou(thread) && subagentsNeedingInput.length
      ? subagentsNeedingInput.length === 1
        ? "Subagent needs input"
        : `${subagentsNeedingInput.length} subagents need input`
      : undefined;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${thread.title || "Untitled thread"}, ${statusLabel ?? threadRowLabel(thread)}${place.branchLabel ? `, ${place.branchLabel}` : ""}${pullRequests ? `, ${pullRequests.label}` : ""}${home.away ? `, ${home.reason}` : ""}${thread.markedUnread ? ", Unread" : ""}`}
        accessibilityState={{ selected: active }}
        onPress={() => void layout.openThread(thread.id)}
        onLongPress={reorder ? undefined : () => setActions(true)}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          const threadId = thread.id;
          ordering?.pickups.modify((pickups) => {
            "worklet";
            pickups[threadId] = height;

            return pickups;
          });
        }}
        accessibilityHint={
          reorder ? "Hold and drag to reorder. Use Thread actions for more options." : "Hold for thread actions."
        }
        accessibilityActions={[
          { name: "longpress", label: "Thread actions" },
          ...(reorder
            ? [
                { name: "increment", label: "Move down" },
                { name: "decrement", label: "Move up" },
              ]
            : []),
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "longpress") setActions(true);

          if (reorder && event.nativeEvent.actionName === "increment") ordering?.move(thread.id, "down");

          if (reorder && event.nativeEvent.actionName === "decrement") ordering?.move(thread.id, "up");
        }}
        style={({ pressed }) => [
          rowStyle,
          {
            backgroundColor: pressed || active ? c.inset : needs ? (c.dark ? "#fbbf240f" : "#f59e0b0f") : "transparent",
            borderColor: needs ? `${c.warning}33` : "transparent",
            opacity: home.away ? 0.55 : 1,
          },
          style,
        ]}
      >
        <SidebarThreadContent
          {...props}
          away={home.away}
          statusLabel={statusLabel}
          onActions={() => setActions(true)}
        />
        <SidebarUnread unread={thread.markedUnread} />
      </Pressable>
      <ThreadActionsSheet
        thread={thread}
        visible={actions}
        onClose={() => setActions(false)}
        onReorder={reorder ? (direction) => ordering?.move(thread.id, direction) : undefined}
      />
    </>
  );
}

function SidebarTitle({ thread, compact = false }: { thread: ui.Thread; compact?: boolean }) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();

  return (
    <Text
      numberOfLines={1}
      style={[type.title, { flex: 1, minWidth: compact ? 40 : 0, color: thread.titleGenerating ? c.muted : c.strong }]}
    >
      {thread.title || "Untitled thread"}
    </Text>
  );
}

function SidebarThreadContent({
  thread,
  project,
  worker,
  subagentsNeedingInput = [],
  reorder = false,
  groupedProject = false,
  groupedWorktree = false,
  away,
  statusLabel,
  onActions,
}: SidebarThreadProps & { away: boolean; statusLabel: string | undefined; onActions: () => void }) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const overview = useOverview();
  const place = threadRowPlace(thread, project);
  const pullRequests = threadPullRequestBadge(thread);

  const showWorker = !(
    worker?.desktopBundled &&
    !worker.revokedAt &&
    !worker.nodeId &&
    !thread.nodeId &&
    overview.computers.length === 0 &&
    overview.workers.filter((candidate) => !candidate.revokedAt).length === 1
  );

  const inline = groupedWorktree && !showWorker;
  const needs = !away && (needsYou(thread) || subagentsNeedingInput.length > 0);
  const busy = !away && !needs && isCalm(thread);
  const result = thread.unseenResult || (thread.status === "failed" ? "failed" : "");
  const directory = groupedProject && place.place.toLowerCase() === project?.name.toLowerCase() ? "" : place.place;

  return (
    <>
      <View style={[styles.row, { gap: groupedProject ? 2 : 8 }]}>
        {!groupedProject && (
          <SidebarActivity thread={subagentsNeedingInput[0] ?? thread} project={project} away={away} />
        )}
        {groupedProject ? (
          <SidebarTitle thread={thread} compact />
        ) : (
          <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {project?.name ?? "Unknown project"}
          </Text>
        )}
        <SidebarStatus
          thread={thread}
          activity={subagentsNeedingInput[0] ?? thread}
          away={away}
          groupedProject={groupedProject}
          label={statusLabel}
          value={needs ? "needs" : busy ? thread.status : result || "age"}
        />
        {inline && (
          <View style={[styles.row, { gap: 2 }]}>
            <SidebarThreadMarks thread={thread} pullRequests={pullRequests} draft compact />
            <ProviderIcon
              provider={thread.provider}
              size={threadRowMarks.icon}
              opacity={threadRowMarks.providerOpacity}
            />
          </View>
        )}
        {reorder && (
          <IconButton
            icon="ellipsis-horizontal"
            label="Thread actions"
            onPress={onActions}
            size={groupedProject ? "sm" : "md"}
          />
        )}
      </View>
      {!groupedProject && (
        <View style={styles.row}>
          <SidebarTitle thread={thread} />
          <DraftMarker threadId={thread.id} />
        </View>
      )}
      {!inline && (
        <SidebarThreadMeta
          pullRequests={pullRequests}
          thread={thread}
          worker={worker}
          place={{ ...place, place: directory }}
          showWorker={showWorker}
          groupedProject={groupedProject}
          groupedWorktree={groupedWorktree}
        />
      )}
    </>
  );
}

/** Meaningful activity shares the fixed status slot so the swipe surface never clips it. */
function SidebarStatus({
  thread,
  activity,
  away,
  groupedProject,
  label,
  value,
}: {
  thread: ui.Thread;
  activity: ui.Thread;
  away: boolean;
  groupedProject: boolean;
  label: string | undefined;
  value: string;
}) {
  const state = workState(activity);
  const meaningful = groupedProject && (away || state === "needs" || state === "asks" || state === "background");

  return (
    <View
      style={{
        width: groupedProject ? 72 : 96,
        minWidth: groupedProject ? 32 : 96,
        flexShrink: groupedProject ? 1 : 0,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      {meaningful && <SidebarActivity thread={activity} away={away} groupedProject />}
      <Swap value={value} style={{ flex: 1, minWidth: 0 }}>
        <SidebarThreadStatus thread={thread} label={label} hasWorkingSpinner={!groupedProject} />
      </Swap>
    </View>
  );
}
