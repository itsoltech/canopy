import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useState } from "react";
import { ThreadActionsSheet } from "../threads/ThreadActionsSheet";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Swap } from "../../ui/MotionViews";
import { isCalm, needsYou, threadRowLabel } from "@canopy/domain/thread-activity";
import { threadPlace } from "@canopy/domain/git-heads";
import { threadRowMarks } from "@canopy/ui/thread-row";
import { useComputerHome } from "../computers/presence";
import { SidebarUnread } from "./SidebarUnread";
import { useSidebarTypography } from "./sidebar-scale";
import { SidebarActivity } from "./SidebarActivity";
import { SidebarThreadStatus } from "./SidebarThreadStatus";
import { IconButton } from "../../ui/components";
import { useSidebarDragContext } from "./sidebar-drag";
import { DraftMarker } from "../drafts/DraftMarker";

const rowStyle: ViewStyle = {
  paddingHorizontal: 12,
  minHeight: 48,
  paddingVertical: 8,
  gap: 2,
  borderRadius: 12,
  borderWidth: 1,
};

export function SidebarThread({
  thread,
  project,
  worker,
  style,
  subagentsNeedingInput = [],
  reorder = false,
}: {
  thread: ui.Thread;
  project?: ui.Project;
  worker?: ui.Worker;
  style?: StyleProp<ViewStyle>;
  subagentsNeedingInput?: readonly ui.Thread[];
  reorder?: boolean;
}) {
  const c = useColors();
  const type = useSidebarTypography();
  const [actions, setActions] = useState(false);
  const ordering = useSidebarDragContext();
  const home = useComputerHome(thread.nodeId);
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  // Wide windows show the open thread beside the list: mark it.
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;
  const needs = !home.away && (needsYou(thread) || subagentsNeedingInput.length > 0);
  const busy = !home.away && !needs && isCalm(thread);
  const result = thread.unseenResult || (thread.status === "failed" ? "failed" : "");

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
        accessibilityLabel={`${thread.title || "Untitled thread"}, ${statusLabel ?? threadRowLabel(thread)}${home.away ? `, ${home.reason}` : ""}${thread.markedUnread ? ", Unread" : ""}`}
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
        <View style={styles.row}>
          <SidebarActivity thread={subagentsNeedingInput[0] ?? thread} project={project} away={home.away} />
          <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {project?.name ?? "Unknown project"}
          </Text>
          {/* A new state (working, needs input, a result) swaps in; the age ticking over does not. */}
          <View style={{ width: 96 }}>
            <Swap value={needs ? "needs" : busy ? thread.status : result || "age"}>
              <SidebarThreadStatus thread={thread} label={statusLabel} />
            </Swap>
          </View>
          {reorder && <IconButton icon="ellipsis-horizontal" label="Thread actions" onPress={() => setActions(true)} />}
        </View>
        <View style={styles.row}>
          <Text numberOfLines={1} style={[type.title, { flex: 1, color: thread.titleGenerating ? c.muted : c.strong }]}>
            {thread.title || "Untitled thread"}
          </Text>
          <DraftMarker threadId={thread.id} />
        </View>
        <View style={[styles.row, { gap: 8 }]}>
          <Icon name="computer-desktop" size={16} color={worker?.online ? c.muted : c.faint} />
          <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {worker?.name ?? "Unknown worker"} · {threadPlace(thread, project)}
          </Text>
          {thread.goalStatus ? <Icon name="flag" size={16} /> : null}
          <ProviderIcon
            provider={thread.provider}
            size={threadRowMarks.icon}
            opacity={threadRowMarks.providerOpacity}
          />
        </View>
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
