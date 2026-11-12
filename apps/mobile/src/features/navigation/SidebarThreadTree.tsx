import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import type { ui } from "@canopy/contracts";
import { sidebarChildren } from "@canopy/domain/sidebar-threads";
import { isSide } from "@canopy/domain/thread-tree";
import { sameItems } from "@canopy/domain/same-items";
import { isCalm, threadRowLabel } from "@canopy/domain/thread-activity";
import { formatAge } from "@canopy/domain/format";
import { useLayout } from "../../state/layout";
import { styles, useColors } from "../../ui/theme";
import { Chevron, Expand } from "../../ui/MotionViews";
import { Icon } from "../../ui/Icon";
import { SidebarThread } from "./SidebarThread";
import { SidebarThreadStatus } from "./SidebarThreadStatus";
import { SidebarActivity } from "./SidebarActivity";
import { useComputerHome } from "../computers/presence";
import { SidebarUnread } from "./SidebarUnread";
import { useSidebarTypography } from "./sidebar-scale";
import { ThreadArchiveSwipe } from "./ThreadArchiveSwipe";

interface TreeProps {
  thread: ui.Thread;
  sideThreads: readonly ui.Thread[];
  rootIds?: ReadonlySet<string>;
  current?: ui.Thread | undefined;
  projects: ui.Project[];
  workers: ui.Worker[];
  archived?: boolean;
}

const openTree = (current: ui.Thread | undefined) => current && (isSide(current) ? current.parentThreadId : current.id);

/**
 * Every overview event renders the list again; a row renders only when what it shows changed: its thread, side
 * threads, place in the open tree, project or worker. Age labels own their clock subscription.
 */
const sameTree = (a: TreeProps, b: TreeProps) =>
  a.thread === b.thread &&
  a.archived === b.archived &&
  sameItems(a.sideThreads, b.sideThreads) &&
  a.sideThreads.every((side) => Boolean(a.rootIds?.has(side.id)) === Boolean(b.rootIds?.has(side.id))) &&
  (openTree(a.current) === a.thread.id) === (openTree(b.current) === b.thread.id) &&
  a.projects.find((p) => p.id === a.thread.projectId) === b.projects.find((p) => p.id === b.thread.projectId) &&
  a.workers.find((w) => w.id === a.thread.workerId) === b.workers.find((w) => w.id === b.thread.workerId);

export const SidebarThreadTreeRow = memo(SidebarThreadTree, sameTree);

/** One tree owns its side rows and attention, including when the same tree is pinned or archived. */
function SidebarThreadTree({ thread, sideThreads, rootIds, current, projects, workers, archived = false }: TreeProps) {
  const { sides, subagentsNeedingInput } = sidebarChildren(sideThreads, rootIds);
  const type = useSidebarTypography();
  const [expanded, setExpanded] = useState<boolean>();
  const [previousOpen, setPreviousOpen] = useState(false);
  const open = expanded ?? (archived || openTree(current) === thread.id);
  const c = useColors();
  const hasSides = sides.active.length + sides.previous.length > 0;

  return (
    <View>
      <ThreadArchiveSwipe thread={thread}>
        <SidebarThread
          thread={thread}
          project={projects.find((p) => p.id === thread.projectId)}
          worker={workers.find((w) => w.id === thread.workerId)}
          subagentsNeedingInput={archived ? [] : subagentsNeedingInput}
        />
      </ThreadArchiveSwipe>
      {hasSides && (
        <View style={{ paddingLeft: 20, paddingBottom: 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Side threads of ${thread.title}`}
            accessibilityState={{ expanded: open }}
            onPress={() => setExpanded(!open)}
            style={[styles.row, { minHeight: 48, gap: 4, paddingHorizontal: 8 }]}
          >
            <Chevron open={open} size={16} />
            <Text numberOfLines={1} style={[type.meta, { flexShrink: 1, color: c.muted }]}>
              {sides.active.length
                ? `${sides.active.length} side ${sides.active.length === 1 ? "thread" : "threads"}`
                : "Side threads"}
            </Text>
          </Pressable>
          <Expand open={open}>
            <View style={{ borderLeftWidth: 1, borderColor: c.rule, paddingLeft: 6 }}>
              {sides.active.map((side) => (
                <ThreadArchiveSwipe key={side.id} thread={side}>
                  <SidebarSideThread thread={side} />
                </ThreadArchiveSwipe>
              ))}
              {sides.previous.length > 0 && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: previousOpen }}
                    onPress={() => setPreviousOpen(!previousOpen)}
                    style={[styles.row, { minHeight: 48, gap: 4, paddingHorizontal: 8 }]}
                  >
                    <Chevron open={previousOpen} size={16} />
                    <Text numberOfLines={1} style={[type.meta, { flexShrink: 1, color: c.muted }]}>
                      Previous agents · {sides.previous.length}
                    </Text>
                  </Pressable>
                  <Expand open={previousOpen}>
                    {sides.previous.map((side) => (
                      <ThreadArchiveSwipe key={side.id} thread={side}>
                        <SidebarSideThread thread={side} previous />
                      </ThreadArchiveSwipe>
                    ))}
                  </Expand>
                </>
              )}
            </View>
          </Expand>
        </View>
      )}
    </View>
  );
}

function SidebarSideThread({ thread, previous = false }: { thread: ui.Thread; previous?: boolean }) {
  const c = useColors();
  const type = useSidebarTypography();
  const home = useComputerHome(thread.nodeId);
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;

  const label = home.away ? "Read-only" : previous ? formatAge(thread.archivedAt) : threadRowLabel(thread);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title || "Untitled thread"}${label ? `, ${label}` : ""}${home.away ? `, ${home.reason}` : ""}${thread.markedUnread ? ", Unread" : ""}`}
      accessibilityState={{ selected: active }}
      onPress={() => void layout.openThread(thread.id)}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: 48,
          borderRadius: 8,
          paddingHorizontal: 8,
          opacity: home.away ? 0.55 : 1,
          backgroundColor: pressed || active ? c.inset : !home.away && isCalm(thread) ? c.well : "transparent",
        },
      ]}
    >
      <SidebarActivity
        thread={thread}
        away={home.away}
        size={16}
        idle={
          <Icon
            name={thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right"}
            size={16}
            color={c.muted}
          />
        }
      />
      <Text numberOfLines={1} style={[type.title, { flex: 1, minWidth: 0, color: c.body }]}>
        {thread.title || "Untitled thread"}
      </Text>
      <View style={{ width: 96 }}>
        <SidebarThreadStatus thread={thread} label={home.away ? "Read-only" : undefined} previous={previous} />
      </View>
      <SidebarUnread unread={thread.markedUnread} />
    </Pressable>
  );
}
