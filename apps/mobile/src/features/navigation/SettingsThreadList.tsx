import { useState, type ReactNode } from "react";
import { Pressable, SectionList, Text } from "react-native";
import { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { styles, useColors } from "../../ui/theme";
import { SidebarThread } from "./SidebarThread";
import { useContentPadding } from "../../ui/ScreenFrame";
import Animated from "react-native-reanimated";
import { Chevron, GlidingCell, useArrivals } from "../../ui/MotionViews";

export function SettingsThreadList({
  threads,
  projects,
  workers,
  loaded,
  empty,
  footer,
}: {
  threads: ui.Thread[];
  /** The list has its first data: rows that come after it rise in. */
  loaded: boolean;
  projects: ui.Project[];
  workers: ui.Worker[];
  empty: ReactNode;
  footer: ReactNode;
}) {
  const { user } = useAppearance();
  const padding = useContentPadding(8);
  const c = useColors();
  const [workingOpen, setWorkingOpen] = useState(true);
  const sidebar = user?.sidebar;

  const arrival = useArrivals(
    threads.map((t) => t.id),
    loaded,
  );

  const working = sidebar?.workingSection
    ? threads.filter((t) => ["running", "creating", "monitoring"].includes(t.status))
    : [];

  const remaining = threads.filter((t) => !working.includes(t));

  const groups = projects
    .map((project) => ({ project, data: remaining.filter((t) => t.projectId === project.id) }))
    .filter((g) => g.data.length);

  groups.sort((a, b) =>
    sidebar?.projectOrder === ui.ProjectOrder.NAME
      ? a.project.name.localeCompare(b.project.name)
      : sidebar?.projectOrder === ui.ProjectOrder.CREATED
        ? Number((b.project.createdAt?.seconds ?? 0n) - (a.project.createdAt?.seconds ?? 0n))
        : threads.indexOf(a.data[0]!) - threads.indexOf(b.data[0]!),
  );

  const sections = [
    ...(working.length ? [{ title: "Working", data: workingOpen ? working : [], working: true }] : []),
    ...(sidebar?.groupByProject
      ? groups.map((g) => ({ title: g.project.name, data: g.data, working: false }))
      : [{ title: "", data: remaining, working: false }]),
  ];

  return (
    <SectionList
      // SectionList shows its empty view only without sections, not for one empty section.
      sections={threads.length ? sections : []}
      keyExtractor={(t) => t.id}
      // Rows glide to their new place when a thread moves up, arrives or leaves.
      CellRendererComponent={GlidingCell}
      stickySectionHeadersEnabled={false}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={[padding, { flexGrow: 1 }]}
      renderSectionHeader={({ section }) =>
        section.title ? (
          <Pressable
            accessibilityRole={section.working ? "button" : "header"}
            accessibilityState={section.working ? { expanded: workingOpen } : {}}
            onPress={section.working ? () => setWorkingOpen(!workingOpen) : undefined}
            style={[styles.row, { padding: 12, minHeight: 44, gap: 4 }]}
          >
            {section.working && <Chevron open={workingOpen} size={14} color={c.muted} />}
            <Text style={[styles.meta, { color: c.muted }]}>{section.title}</Text>
          </Pressable>
        ) : null
      }
      renderItem={({ item }) => (
        // No exit: virtualization unmounts rows too. A row that leaves goes at once and the rest glide up.
        <Animated.View entering={arrival(item.id)}>
          <SidebarThread
            thread={item}
            project={projects.find((p) => p.id === item.projectId)}
            worker={workers.find((w) => w.id === item.workerId)}
          />
        </Animated.View>
      )}
      ListEmptyComponent={<>{empty}</>}
      ListFooterComponent={<>{footer}</>}
      ListFooterComponentStyle={{ flexGrow: 1 }}
    />
  );
}
