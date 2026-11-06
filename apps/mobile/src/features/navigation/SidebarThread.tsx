import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useLayout } from "../../state/layout";
import type { ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { ProjectMark } from "../../ui/ProjectMark";
import { Swap } from "../../ui/MotionViews";

export function age(seconds?: bigint) {
  if (!seconds) return "";
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - Number(seconds)) / 60));

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
}: {
  thread: ui.Thread;
  project?: ui.Project;
  worker?: ui.Worker;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  // Wide windows show the open thread beside the list: mark it.
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;
  const needs = thread.pendingInteractions > 0 || thread.status === "waiting_input";
  const busy = ["running", "creating"].includes(thread.status);
  const result = thread.unseenResult || (thread.status === "failed" ? "failed" : "");

  const label = needs
    ? "Needs input"
    : busy
      ? thread.status === "creating"
        ? "Starting"
        : "Working"
      : result
        ? result[0]!.toUpperCase() + result.slice(1)
        : age(thread.lastActivityAt?.seconds ?? thread.createdAt?.seconds);

  const tone = needs
    ? c.warning
    : busy
      ? c.sky
      : result === "completed"
        ? c.success
        : result === "failed"
          ? c.danger
          : c.muted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title || "Untitled thread"}, ${label}`}
      accessibilityState={{ selected: active }}
      onPress={() => layout.open({ pathname: "/thread/[id]", params: { id: thread.id } })}
      style={({ pressed }) => [
        {
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 2,
          borderRadius: 12,
          backgroundColor: pressed || active ? c.inset : needs ? (c.dark ? "#fbbf240f" : "#f59e0b0f") : "transparent",
          borderWidth: needs ? 1 : 0,
          borderColor: `${c.warning}33`,
        },
        style,
      ]}
    >
      <View style={[styles.row, { opacity: busy ? 0.7 : 1 }]}>
        {needs || busy ? (
          <View
            style={{
              width: 18,
              height: 18,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name={needs ? "hand-raised" : "arrow-path"} size={14} color={tone} />
          </View>
        ) : (
          <ProjectMark name={project?.name ?? "?"} kind={project?.kind} />
        )}
        <Text numberOfLines={1} style={[styles.meta, { flex: 1, color: c.muted }]}>
          {project?.name ?? "Unknown project"}
        </Text>
        {/* A new state (working, needs input, a result) swaps in; the age ticking over does not. */}
        <Swap value={needs ? "needs" : busy ? thread.status : result || "age"}>
          <Text style={[styles.meta, { color: tone }]}>{label}</Text>
        </Swap>
      </View>
      <Text numberOfLines={1} style={[styles.body, { color: c.body, opacity: busy ? 0.6 : 1 }]}>
        {thread.title || "Untitled thread"}
      </Text>
      <View style={[styles.row, { gap: 6, opacity: busy ? 0.6 : 1 }]}>
        <Icon name="computer-desktop" size={14} color={worker?.online ? c.muted : c.faint} />
        <Text numberOfLines={1} style={[styles.meta, { flex: 1, color: c.muted }]}>
          {worker?.name ?? "Unknown worker"} ·{" "}
          {project?.kind === "scratch" ? "scratch folder" : (thread.cwd.split("/").filter(Boolean).pop() ?? thread.cwd)}
        </Text>
        {thread.goalStatus ? <Icon name="flag" size={14} /> : null}
        <ProviderIcon provider={thread.provider} />
      </View>
    </Pressable>
  );
}
