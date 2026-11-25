import type { ReactNode } from "react";
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
import { SidebarThreadTreeRow } from "./SidebarThreadTree";
import type { useSidebarThreads } from "./useSidebarThreads";
import { SidebarArchivedHeader, SidebarArchivedStatus, useArchivedThreads } from "./SidebarArchivedThreads";
import { useSnoozedThreads } from "./SidebarSnoozedThreads";
import { SidebarDisclosureRow, SidebarThreadDisclosure, useSidebarDisclosureMotion } from "./SidebarThreadDisclosure";
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
  const { rise, layout } = useMotion();
  const { view, setView } = useDevicePreferences();
  const workingOpen = view.workingThreadsExpanded;
  const working = useSidebarDisclosureMotion(workingOpen);
  const snoozed = useSnoozedThreads(navigation);
  const disclosing = working.animating || snoozed.animating;
  const { filtered, settings, choices } = navigation;
  const grouping = { groupByWorktree: view.groupByWorktree };
  const entries = sidebarEntries(filtered, settings, choices, working.rendered, grouping);

  const natural = sidebarEntries(
    { ...filtered, pins: new Set<string>() },
    settings,
    choices,
    working.rendered,
    grouping,
  );

  const visible = visibleSidebarEntries(entries, view.collapsedSidebarGroups, Boolean(navigation.query.trim()));
  const order = useSidebarOrder(entries, natural, settings);
  const custom = navigation.sortMode === "custom";

  const drag = useSidebarDrag(
    dragItems(visible, natural, settings.pinnedThreadIds),
    settings.groupByProject,
    custom && !disclosing,
    order,
    header.offset,
    header.listTop,
  );

  const archive = useArchivedThreads(navigation);
  const workingIndex = visible.findIndex((entry) => entry.working);

  const active: SidebarListEntry[] = visible.map((entry, index) => ({
    ...entry,
    section: workingIndex >= 0 && index > workingIndex ? "working" : "active",
  }));

  const rows: SidebarListEntry[] = [
    ...active,
    ...(!active.length && !snoozed.count ? [{ key: "empty", section: "empty" as const }] : []),
    ...snoozed.entries,
    ...archivedEntries(archive),
  ];

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
        <GestureHandlerRootView style={styles.fill}>
          <GestureDetector gesture={drag.gesture}>
            <Animated.View ref={drag.frame} style={styles.fill}>
              <ThreadFlatList
                ref={drag.list}
                data={data}
                CellRendererComponent={SidebarOrderCell}
                keyExtractor={(entry) => entry.key}
                {...header.listProps}
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                windowSize={7}
                onContentSizeChange={(_, height) => drag.content.set(height)}
                onEndReached={archive.more}
                onEndReachedThreshold={0.4}
                renderItem={({ item }) => {
                  const disclosure =
                    item.section === "working" ? working : item.section === "snoozed" ? snoozed : undefined;

                  return (
                    <SidebarDisclosureRow
                      disclosure={disclosure}
                      entering={disclosure?.animating ? undefined : arrival(item.key)}
                      exiting={disclosure?.animating ? undefined : rise.exiting}
                      layout={!disclosing && item.section === "archived-heading" ? layout : undefined}
                    >
                      <SidebarNesting depth={item.depth}>
                        <SidebarListEntryView
                          {...{ item, navigation, archive, snoozed, rootIds, projects, workers, empty, workingOpen }}
                          onWorking={() => setView({ workingThreadsExpanded: !workingOpen })}
                        />
                      </SidebarNesting>
                    </SidebarDisclosureRow>
                  );
                }}
              />
              <SidebarDragFeedback entries={entries} />
            </Animated.View>
          </GestureDetector>
        </GestureHandlerRootView>
      </LayoutAnimationConfig>
    </SidebarDragContext.Provider>
  );
}

function archivedEntries(archive: ReturnType<typeof useArchivedThreads>): SidebarListEntry[] {
  if (!archive.visible) return [];

  const entries: SidebarListEntry[] = [{ key: "archived-heading", section: "archived-heading" }];
  const threads = archive.expanded ? archive.roots : archive.sticky ? [archive.sticky] : [];

  for (const thread of threads) entries.push({ key: `archived-${thread.id}`, thread, section: "archived" });

  if (archive.expanded) entries.push({ key: "archived-status", section: "status" });

  return entries;
}

function SidebarListEntryView({
  item,
  navigation,
  archive,
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
  archive: ReturnType<typeof useArchivedThreads>;
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

  if (item.section === "archived-heading") return <SidebarArchivedHeader archive={archive} />;

  if (item.section === "status") return <SidebarArchivedStatus archive={archive} />;

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
