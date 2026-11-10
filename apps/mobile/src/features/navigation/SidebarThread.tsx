import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useState } from "react";
import { ThreadActionsSheet } from "../threads/ThreadActionsSheet";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { ProjectMark } from "../../ui/ProjectMark";
import { Swap } from "../../ui/MotionViews";
import { needsYou } from "@canopy/domain/thread-activity";
import { useComputerHome } from "../computers/presence";
import { SidebarUnread } from "./SidebarUnread";
import { useSidebarTypography } from "./sidebar-scale";

const rowStyle: ViewStyle = {
  paddingHorizontal: 12,
  minHeight: 48,
  paddingVertical: 8,
  gap: 2,
  borderRadius: 12,
  borderWidth: 1,
};

export function age(seconds?: bigint, now = Date.now()) {
  if (!seconds) return "";
  const minutes = Math.max(0, Math.floor((now / 1000 - Number(seconds)) / 60));

  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}

export function SidebarThread({
  thread,
  project,
  worker,
  style,
  subagentsNeedingInput = [],
}: {
  thread: ui.Thread;
  project?: ui.Project;
  worker?: ui.Worker;
  style?: StyleProp<ViewStyle>;
  subagentsNeedingInput?: readonly ui.Thread[];
}) {
  const c = useColors();
  const type = useSidebarTypography();
  const [actions, setActions] = useState(false);
  const home = useComputerHome(thread.nodeId);
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  // Wide windows show the open thread beside the list: mark it.
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;
  const needs = !home.away && (needsYou(thread) || subagentsNeedingInput.length > 0);
  const busy = !home.away && !needs && ["running", "creating"].includes(thread.status);
  const result = thread.unseenResult || (thread.status === "failed" ? "failed" : "");

  const label = home.away
    ? "Read-only"
    : needs
      ? needsYou(thread)
        ? "Needs input"
        : subagentsNeedingInput.length === 1
          ? "Subagent needs input"
          : `${subagentsNeedingInput.length} subagents need input`
      : busy
        ? thread.status === "creating"
          ? "Starting"
          : "Working"
        : result
          ? result[0]!.toUpperCase() + result.slice(1)
          : age(thread.lastActivityAt?.seconds ?? thread.createdAt?.seconds);

  const tone = home.away
    ? c.muted
    : needs
      ? c.warning
      : busy
        ? c.sky
        : result === "completed"
          ? c.success
          : result === "failed"
            ? c.danger
            : c.muted;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${thread.title || "Untitled thread"}, ${label}${home.away ? `, ${home.reason}` : ""}${thread.markedUnread ? ", Unread" : ""}`}
        accessibilityState={{ selected: active }}
        onPress={() => void layout.openThread(thread.id)}
        onLongPress={() => setActions(true)}
        accessibilityHint="Hold for thread actions."
        accessibilityActions={[{ name: "longpress", label: "Thread actions" }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "longpress") setActions(true);
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
        <View style={[styles.row, { opacity: busy ? 0.7 : 1 }]}>
          {needs || busy ? (
            <View
              style={{
                width: 20,
                height: 20,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name={needs ? "hand-raised" : "arrow-path"} size={16} color={tone} />
            </View>
          ) : (
            <ProjectMark name={project?.name ?? "?"} kind={project?.kind} size={20} />
          )}
          <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {project?.name ?? "Unknown project"}
          </Text>
          {/* A new state (working, needs input, a result) swaps in; the age ticking over does not. */}
          <View style={{ width: 96 }}>
            <Swap value={needs ? "needs" : busy ? thread.status : result || "age"}>
              <Text numberOfLines={1} style={[type.meta, { color: tone, textAlign: "right" }]}>
                {label}
              </Text>
            </Swap>
          </View>
        </View>
        <Text numberOfLines={1} style={[type.title, { color: c.body, opacity: busy ? 0.6 : 1 }]}>
          {thread.title || "Untitled thread"}
        </Text>
        <View style={[styles.row, { gap: 8, opacity: busy ? 0.6 : 1 }]}>
          <Icon name="computer-desktop" size={16} color={worker?.online ? c.muted : c.faint} />
          <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {worker?.name ?? "Unknown worker"} ·{" "}
            {project?.kind === "scratch"
              ? "scratch folder"
              : (thread.cwd.split("/").filter(Boolean).pop() ?? thread.cwd)}
          </Text>
          {thread.goalStatus ? <Icon name="flag" size={16} /> : null}
          <ProviderIcon provider={thread.provider} size={16} />
        </View>
        <SidebarUnread unread={thread.markedUnread} />
      </Pressable>
      <ThreadActionsSheet thread={thread} visible={actions} onClose={() => setActions(false)} />
    </>
  );
}
