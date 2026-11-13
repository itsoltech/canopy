import { useState, type ReactNode } from "react";
import { FlatList, Pressable, Text } from "react-native";
import { ui } from "@canopy/contracts";
import { sidebarEntries } from "@canopy/domain/sidebar-entries";
import { styles, useColors } from "../../ui/theme";
import { useContentPadding } from "../../ui/ScreenFrame";
import Animated from "react-native-reanimated";
import { Chevron, useArrivals } from "../../ui/MotionViews";
import { useMotion } from "../../ui/motion";
import { SidebarThreadTreeRow } from "./SidebarThreadTree";
import type { useSidebarThreads } from "./useSidebarThreads";
import { SidebarArchivedHeader, SidebarArchivedStatus, useArchivedThreads } from "./SidebarArchivedThreads";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSidebarOrder } from "./sidebar-order";
import { SidebarDragContext, useSidebarDrag, type SidebarListEntry } from "./sidebar-drag";
import { dragItems } from "./sidebar-drag-target";
import { SidebarDragFeedback, SidebarOrderCell } from "./SidebarDragFeedback";

const ThreadFlatList = Animated.createAnimatedComponent(FlatList<SidebarListEntry>);

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
  const { rise } = useMotion();
  const [workingOpen, setWorkingOpen] = useState(false);
  const { filtered, settings, choices } = navigation;
  const entries = sidebarEntries(filtered, settings, choices, workingOpen);
  const natural = sidebarEntries({ ...filtered, pins: new Set<string>() }, settings, choices, workingOpen);
  const order = useSidebarOrder(entries, natural, settings);
  const custom = navigation.sortMode === "custom";

  const drag = useSidebarDrag(
    dragItems(entries, natural, settings.pinnedThreadIds),
    settings.groupByProject,
    custom,
    order,
  );

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

  const data: SidebarListEntry[] = [
    ...active,
    ...(!active.length ? [{ key: "empty", section: "empty" as const }] : []),
    ...archived,
  ];

  const rootIds = new Set(filtered.roots.map((t) => t.id));

  const arrival = useArrivals(
    data.map((e) => e.key),
    loaded,
  );

  return (
    <SidebarDragContext.Provider value={drag.context}>
      <GestureHandlerRootView style={styles.fill}>
        <GestureDetector gesture={drag.gesture}>
          <Animated.View ref={drag.frame} style={styles.fill}>
            <ThreadFlatList
              ref={drag.list}
              data={data}
              CellRendererComponent={SidebarOrderCell}
              keyExtractor={(entry) => entry.key}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              contentContainerStyle={[padding, { flexGrow: 1 }]}
              initialNumToRender={12}
              maxToRenderPerBatch={8}
              windowSize={7}
              onScroll={drag.scroll}
              scrollEventThrottle={16}
              onContentSizeChange={(_, height) => drag.context.content.set(height)}
              onEndReached={archive.more}
              onEndReachedThreshold={0.4}
              renderItem={({ item }) => (
                <Animated.View
                  entering={arrival(item.key)}
                  exiting={item.section === "archived" ? rise.exiting : undefined}
                >
                  <SidebarListEntryView
                    {...{ item, navigation, archive, rootIds, projects, workers, empty, workingOpen }}
                    onWorking={() => setWorkingOpen(!workingOpen)}
                  />
                </Animated.View>
              )}
            />
            <SidebarDragFeedback entries={entries} />
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </SidebarDragContext.Provider>
  );
}

function SidebarListEntryView({
  item,
  navigation,
  archive,
  rootIds,
  projects,
  workers,
  empty,
  workingOpen,
  onWorking,
}: {
  item: SidebarListEntry;
  navigation: ReturnType<typeof useSidebarThreads>;
  archive: ReturnType<typeof useArchivedThreads>;
  rootIds: ReadonlySet<string>;
  projects: ui.Project[];
  workers: ui.Worker[];
  empty: ReactNode;
  workingOpen: boolean;
  onWorking: () => void;
}) {
  const c = useColors();
  const { current, filtered } = navigation;

  if (item.section === "empty") return empty;

  if (item.section === "heading") return <SidebarArchivedHeader archive={archive} />;

  if (item.section === "status") return <SidebarArchivedStatus archive={archive} />;

  if (item.section === "archived" && item.thread)
    return (
      <SidebarThreadTreeRow
        thread={item.thread}
        archived
        current={current}
        projects={archive.projects}
        workers={archive.workers}
        sideThreads={archive.sideThreads.get(item.thread.id) ?? []}
      />
    );

  if (item.thread)
    return (
      <SidebarThreadTreeRow
        thread={item.thread}
        sideThreads={filtered.sides.get(item.thread.id) ?? []}
        rootIds={rootIds}
        current={current}
        projects={projects}
        workers={workers}
        reorder={navigation.sortMode === "custom" && !item.thread.nodeId}
      />
    );

  return (
    <Pressable
      accessibilityRole={item.working ? "button" : "header"}
      accessibilityState={item.working ? { expanded: workingOpen } : {}}
      onPress={item.working ? onWorking : undefined}
      style={[styles.row, { padding: 12, minHeight: 44, gap: 4 }]}
    >
      {item.working && <Chevron open={workingOpen} size={14} color={c.muted} />}
      <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
        {item.heading}
      </Text>
    </Pressable>
  );
}
