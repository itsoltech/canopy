import { useState, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { ui } from "@canopy/contracts";
import { sidebarEntries } from "@canopy/domain/sidebar-entries";
import { styles, useColors } from "../../ui/theme";
import { useContentPadding } from "../../ui/ScreenFrame";
import Animated from "react-native-reanimated";
import { Chevron, useArrivals } from "../../ui/MotionViews";
import { useMotion } from "../../ui/motion";
import { SidebarThreadTree } from "./SidebarThreadTree";
import type { useSidebarThreads } from "./useSidebarThreads";
import { SidebarArchivedHeader, SidebarArchivedStatus, useArchivedThreads } from "./SidebarArchivedThreads";

export function SettingsThreadList({
  navigation,
  projects,
  workers,
  loaded,
  empty,
}: {
  navigation: ReturnType<typeof useSidebarThreads>;
  loaded: boolean;
  projects: ui.Project[];
  workers: ui.Worker[];
  empty: ReactNode;
}) {
  const padding = useContentPadding(8);
  const c = useColors();
  const { layout, rise } = useMotion();
  const [workingOpen, setWorkingOpen] = useState(false);
  const { filtered, settings, choices, current } = navigation;
  const entries = sidebarEntries(filtered, settings, choices, workingOpen);
  const archive = useArchivedThreads(navigation);
  const active = entries.map((entry) => ({ ...entry, section: "active" as const }));

  const archived = archive.visible
    ? [
        { key: "archived-heading", section: "heading" as const },
        ...(archive.expanded
          ? [
              ...archive.roots.map((thread) => ({
                key: `archived-${thread.id}`,
                thread,
                section: "archived" as const,
              })),
              { key: "archived-status", section: "status" as const },
            ]
          : archive.sticky
            ? [{ key: `archived-${archive.sticky.id}`, thread: archive.sticky, section: "archived" as const }]
            : []),
      ]
    : [];

  const data = [...active, ...(!active.length ? [{ key: "empty", section: "empty" as const }] : []), ...archived];
  const rootIds = new Set(filtered.roots.map((t) => t.id));

  const arrival = useArrivals(
    data.map((e) => e.key),
    loaded,
  );

  return (
    <Animated.FlatList
      data={data}
      keyExtractor={(entry) => entry.key}
      itemLayoutAnimation={layout}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={[padding, { flexGrow: 1 }]}
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      windowSize={7}
      onEndReached={archive.more}
      onEndReachedThreshold={0.4}
      renderItem={({ item }) => (
        <Animated.View entering={arrival(item.key)} exiting={item.section === "archived" ? rise.exiting : undefined}>
          {item.section === "empty" ? (
            empty
          ) : item.section === "heading" ? (
            <SidebarArchivedHeader archive={archive} />
          ) : item.section === "status" ? (
            <SidebarArchivedStatus archive={archive} />
          ) : item.section === "archived" ? (
            <SidebarThreadTree
              thread={item.thread}
              archived
              current={current}
              projects={archive.projects}
              workers={archive.workers}
              sideThreads={archive.sideThreads.get(item.thread.id) ?? []}
            />
          ) : item.thread ? (
            <SidebarThreadTree
              thread={item.thread}
              sideThreads={filtered.sides.get(item.thread.id) ?? []}
              rootIds={rootIds}
              current={current}
              projects={projects}
              workers={workers}
            />
          ) : (
            <Pressable
              accessibilityRole={item.working ? "button" : "header"}
              accessibilityState={item.working ? { expanded: workingOpen } : {}}
              onPress={item.working ? () => setWorkingOpen(!workingOpen) : undefined}
              style={[styles.row, { padding: 12, minHeight: 44, gap: 4 }]}
            >
              {item.working && <Chevron open={workingOpen} size={14} color={c.muted} />}
              <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
                {item.heading}
              </Text>
            </Pressable>
          )}
        </Animated.View>
      )}
    />
  );
}
