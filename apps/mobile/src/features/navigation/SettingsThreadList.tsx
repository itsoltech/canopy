import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { FlatList, Text } from "react-native";
import { ui } from "@canopy/contracts";
import { visibleSidebarEntries } from "@canopy/domain/sidebar-groups";
import { useDevicePreferences } from "../settings/device-preferences";
import { SidebarGroupHeading, SidebarNesting } from "./SidebarGroupHeading";
import { sidebarEntries } from "@canopy/domain/sidebar-entries";
import { styles, useColors, weightedFont } from "../../ui/theme";
import type { SidebarListHeader } from "./SidebarListHeader";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { useArrivals } from "../../ui/MotionViews";
import { useMotion } from "../../ui/motion";
import { useContentInsets } from "../../ui/ScreenFrame";
import { SidebarThreadTreeRow } from "./SidebarThreadTree";
import type { useSidebarThreads } from "./useSidebarThreads";
import { SidebarArchivedSection } from "./SidebarArchivedThreads";
import { useSnoozedThreads } from "./SidebarSnoozedThreads";
import { SidebarThreadDisclosure } from "./SidebarThreadDisclosure";
import { sidebarRowPadding, useSidebarTypography } from "./sidebar-scale";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSidebarOrder } from "./sidebar-order";
import { SidebarDragContext, useSidebarDrag, type SidebarListEntry } from "./sidebar-drag";
import { dragItems } from "./sidebar-drag-target";
import { SidebarDragFeedback, SidebarOrderCell } from "./SidebarDragFeedback";

const ThreadFlatList = Animated.createAnimatedComponent(FlatList<SidebarListEntry>);

export function SettingsThreadList({
  header,
  navigation,
  projects,
  workers,
  loaded,
  empty,
}: {
  header: SidebarListHeader;
  navigation: ReturnType<typeof useSidebarThreads>;
  loaded: boolean;
  projects: ui.Project[];
  workers: ui.Worker[];
  empty: ReactNode;
}) {
  const { rise } = useMotion();
  const insets = useContentInsets();
  const { view, setView } = useDevicePreferences();
  const { workingThreadsExpanded: workingOpen, groupByWorktree } = view;
  const snoozed = useSnoozedThreads(navigation);
  const previous = useRef({ workingOpen, snoozedOpen: snoozed.expanded });
  const workingChanged = previous.current.workingOpen !== workingOpen;
  const snoozedChanged = previous.current.snoozedOpen !== snoozed.expanded;
  const disclosing = workingChanged || snoozedChanged;

  useLayoutEffect(() => {
    previous.current = { workingOpen, snoozedOpen: snoozed.expanded };
  }, [workingOpen, snoozed.expanded]);

  const { filtered, settings, choices } = navigation;

  const entries = useMemo(
    () => sidebarEntries(filtered, settings, choices, workingOpen, { groupByWorktree }),
    [filtered, settings, choices, workingOpen, groupByWorktree],
  );

  const natural = useMemo(
    () => sidebarEntries({ ...filtered, pins: new Set() }, settings, choices, workingOpen, { groupByWorktree }),
    [filtered, settings, choices, workingOpen, groupByWorktree],
  );

  const visible = visibleSidebarEntries(entries, view.collapsedSidebarGroups, Boolean(navigation.query.trim()));
  const order = useSidebarOrder(entries, natural, settings);
  const custom = navigation.sortMode === "custom";

  const drag = useSidebarDrag(
    dragItems(visible, natural, settings.pinnedThreadIds),
    settings.groupByProject,
    custom,
    order,
    header.offset,
    header.listTop,
  );

  const workingIndex = visible.findIndex((entry) => entry.working);

  const active: SidebarListEntry[] = visible.map((entry, index) => ({
    ...entry,
    section: workingIndex >= 0 && index > workingIndex ? "working" : "active",
  }));

  const ordered =
    view.workingSectionPosition === "top" && workingIndex > 0
      ? [...active.slice(workingIndex), ...active.slice(0, workingIndex)]
      : active;

  const rows: SidebarListEntry[] = [
    ...ordered,
    ...(!active.length && !snoozed.count ? [{ key: "empty", section: "empty" as const }] : []),
    ...snoozed.entries,
  ];

  // Insert or remove the section in one layout without gliding other cells over the new rows.
  const data = disclosing ? rows.map((row) => ({ ...row, disclosing: true })) : rows;

  const rootIds = new Set(filtered.roots.map((t) => t.id));

  const arrival = useArrivals(
    data.map((e) => e.key),
    loaded,
  );

  return (
    <SidebarDragContext.Provider value={drag.context}>
      {/* Switching to Bots unmounts the whole list: its rows leave at once instead of fading over the next list. */}
      <LayoutAnimationConfig skipExiting>
        <GestureHandlerRootView style={[styles.fill, { marginBottom: insets.bottom }]}>
          <GestureDetector gesture={drag.gesture}>
            <Animated.View ref={drag.frame} style={styles.fill}>
              <ThreadFlatList
                ref={drag.list}
                data={data}
                CellRendererComponent={SidebarOrderCell}
                keyExtractor={(entry) => entry.key}
                {...header.listProps}
                contentContainerStyle={{ ...header.listProps.contentContainerStyle, paddingBottom: 8 }}
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                windowSize={7}
                onContentSizeChange={(_, height) => drag.content.set(height)}
                renderItem={({ item }) => {
                  const workingRow = item.section === "working";
                  const snoozedRow = item.section === "snoozed";
                  const disclosureRow = workingRow || snoozedRow;
                  const toggled = (workingRow && workingChanged) || (snoozedRow && snoozedChanged);

                  return (
                    <Animated.View
                      entering={toggled ? undefined : arrival(item.key)}
                      exiting={disclosureRow ? undefined : rise.exiting}
                      style={disclosureRow && { paddingTop: 2 }}
                    >
                      <SidebarNesting depth={item.depth}>
                        <SidebarListEntryView
                          {...{ item, navigation, snoozed, rootIds, projects, workers, empty, workingOpen }}
                          onWorking={() => setView({ workingThreadsExpanded: !workingOpen })}
                        />
                      </SidebarNesting>
                    </Animated.View>
                  );
                }}
              />
              <SidebarDragFeedback entries={entries} />
            </Animated.View>
          </GestureDetector>
          <SidebarArchivedSection navigation={navigation} />
        </GestureHandlerRootView>
      </LayoutAnimationConfig>
    </SidebarDragContext.Provider>
  );
}

function SidebarListEntryView({
  item,
  navigation,
  snoozed,
  rootIds,
  projects,
  workers,
  empty,
  workingOpen,
  onWorking,
}: {
  item: SidebarListEntry;
  navigation: ReturnType<typeof useSidebarThreads>;
  snoozed: ReturnType<typeof useSnoozedThreads>;
  rootIds: ReadonlySet<string>;
  projects: ui.Project[];
  workers: ui.Worker[];
  empty: ReactNode;
  workingOpen: boolean;
  onWorking: () => void;
}) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const { current, filtered } = navigation;

  if (item.section === "empty") return empty;

  if (item.section === "snoozed-heading")
    return (
      <SidebarThreadDisclosure
        label={`Snoozed (${snoozed.count})`}
        expanded={snoozed.expanded}
        onToggle={snoozed.toggle}
      />
    );

  if (item.working && item.heading)
    return <SidebarThreadDisclosure working label={item.heading} expanded={workingOpen} onToggle={onWorking} />;

  if (item.thread) {
    const sleeping = item.section === "snoozed";
    const children = sleeping ? filtered.snoozedSides : filtered.sides;

    return (
      <SidebarThreadTreeRow
        thread={item.thread}
        snoozed={sleeping}
        groupedProject={item.groupedProject}
        groupedWorktree={item.depth === 2}
        sideThreads={children.get(item.thread.id) ?? []}
        rootIds={sleeping ? undefined : rootIds}
        showSides={sleeping && snoozed.searching}
        current={current}
        projects={projects}
        workers={workers}
        reorder={!sleeping && navigation.sortMode === "custom" && !item.thread.nodeId}
      />
    );
  }

  if (item.groupKind)
    return (
      <SidebarGroupHeading
        entry={item}
        project={projects.find((project) => project.id === item.projectId)}
        searching={Boolean(navigation.query.trim())}
      />
    );

  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      style={[
        type.heading,
        weightedFont(type.heading.fontFamily, "medium"),
        { color: c.muted, paddingHorizontal: sidebarRowPadding, paddingTop: 12, paddingBottom: 4 },
      ]}
    >
      {item.heading}
    </Text>
  );
}
