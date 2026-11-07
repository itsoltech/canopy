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

export function SettingsThreadList({
  navigation,
  projects,
  workers,
  loaded,
  empty,
  footer,
}: {
  navigation: ReturnType<typeof useSidebarThreads>;
  loaded: boolean;
  projects: ui.Project[];
  workers: ui.Worker[];
  empty: ReactNode;
  footer: ReactNode;
}) {
  const padding = useContentPadding(8);
  const c = useColors();
  const { layout } = useMotion();
  const [workingOpen, setWorkingOpen] = useState(false);
  const { filtered, settings, choices, current } = navigation;
  const entries = sidebarEntries(filtered, settings, choices, workingOpen);
  const rootIds = new Set(filtered.roots.map((t) => t.id));

  const arrival = useArrivals(
    entries.map((e) => e.key),
    loaded,
  );

  return (
    <Animated.FlatList
      data={entries}
      keyExtractor={(entry) => entry.key}
      itemLayoutAnimation={layout}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={[padding, { flexGrow: 1 }]}
      renderItem={({ item }) => (
        <Animated.View entering={arrival(item.key)}>
          {item.thread ? (
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
      ListEmptyComponent={<>{empty}</>}
      ListFooterComponent={<>{footer}</>}
      ListFooterComponentStyle={{ flexGrow: 1 }}
    />
  );
}
