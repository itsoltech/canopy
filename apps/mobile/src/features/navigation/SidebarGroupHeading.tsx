import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import type { SidebarEntry } from "@canopy/domain/sidebar-entries";
import { useDevicePreferences } from "../settings/device-preferences";
import { ProjectMark } from "../../ui/ProjectMark";
import { Icon } from "../../ui/Icon";
import { Chevron } from "../../ui/MotionViews";
import { useColors } from "../../ui/theme";
import { useSidebarTypography } from "./sidebar-scale";

/** Flat list cells share continuous guides without giving up virtualization or drag geometry. */
export function SidebarNesting({ depth, children }: { depth?: 1 | 2; children: ReactNode }) {
  const c = useColors();

  return (
    <View style={{ paddingLeft: (depth ?? 0) * 20 }}>
      {depth && <View pointerEvents="none" style={[s.guide, { left: 10, backgroundColor: c.rule }]} />}
      {depth === 2 && <View pointerEvents="none" style={[s.guide, { left: 30, backgroundColor: c.rule }]} />}
      {children}
    </View>
  );
}

export function SidebarGroupHeading({
  entry,
  project,
  searching,
}: {
  entry: SidebarEntry;
  project?: ui.Project;
  searching: boolean;
}) {
  const device = useDevicePreferences();
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const groups = device.view.collapsedSidebarGroups;
  const collapsed = !searching && groups.includes(entry.key);
  const count = new Intl.NumberFormat().format(entry.count ?? 0);

  return (
    <View style={entry.groupKind === "project" ? { paddingTop: 8 } : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.heading}, ${count} ${(entry.count ?? 0) === 1 ? "thread" : "threads"}`}
        accessibilityHint={entry.groupTitle}
        accessibilityState={{ expanded: !collapsed, disabled: searching }}
        disabled={searching}
        onPress={() =>
          device.setView({
            collapsedSidebarGroups: collapsed ? groups.filter((key) => key !== entry.key) : [...groups, entry.key],
          })
        }
        style={({ pressed }) => [s.heading, { backgroundColor: pressed ? c.inset : "transparent" }]}
      >
        {entry.groupKind === "project" ? (
          <ProjectMark name={entry.heading ?? "?"} kind={project?.kind} size={20} />
        ) : (
          <Icon name="git-fork" size={14} color={c.muted} />
        )}
        <Text numberOfLines={1} style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
          {entry.heading}
        </Text>
        <Text style={[type.caption, { color: c.muted, fontVariant: ["tabular-nums"] }]}>{count}</Text>
        <Chevron open={!collapsed} size={14} color={c.muted} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  guide: { position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    minHeight: 48,
    gap: 8,
    borderRadius: 8,
  },
});
