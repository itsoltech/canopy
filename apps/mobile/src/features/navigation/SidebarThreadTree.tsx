import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useGlobalSearchParams, usePathname } from "expo-router";
import type { ui } from "@canopy/contracts";
import { sidebarChildren } from "@canopy/domain/sidebar-threads";
import { isSide } from "@canopy/domain/thread-tree";
import { sameItems } from "@canopy/domain/same-items";
import { isCalm, threadRowLabel } from "@canopy/domain/thread-activity";
import { formatAge } from "@canopy/domain/format";
import { useLayout } from "../../state/layout";
import { styles, useColors } from "../../ui/theme";
import { Chevron } from "../../ui/MotionViews";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { Icon } from "../../ui/Icon";
import { SidebarThread } from "./SidebarThread";
import { SidebarThreadStatus } from "./SidebarThreadStatus";
import { SidebarActivity } from "./SidebarActivity";
import { useComputerHome } from "../computers/presence";
import { SidebarUnread } from "./SidebarUnread";
import { useSidebarTypography } from "./sidebar-scale";
import { ThreadArchiveSwipe } from "./ThreadArchiveSwipe";
import { ThreadActionsSheet } from "../threads/ThreadActionsSheet";

interface TreeProps {
  thread: ui.Thread;
  sideThreads: readonly ui.Thread[];
  rootIds?: ReadonlySet<string>;
  current?: ui.Thread | undefined;
  projects: ui.Project[];
  workers: ui.Worker[];
  archived?: boolean;
  snoozed?: boolean;
  showSides?: boolean;
  reorder?: boolean;
  groupedProject?: boolean;
  groupedWorktree?: boolean;
}

const openTree = (current: ui.Thread | undefined) => current && (isSide(current) ? current.parentThreadId : current.id);
const revealSides = FadeIn.duration(motion.quick).easing(smoothOut);

/**
 * Every overview event renders the list again; a row renders only when what it shows changed: its thread, side
 * threads, place in the open tree, project or worker. Age labels own their clock subscription.
 */
const sameTree = (a: TreeProps, b: TreeProps) =>
  a.thread === b.thread &&
  a.archived === b.archived &&
  a.snoozed === b.snoozed &&
  a.showSides === b.showSides &&
  a.reorder === b.reorder &&
  a.groupedProject === b.groupedProject &&
  a.groupedWorktree === b.groupedWorktree &&
  sameItems(a.sideThreads, b.sideThreads) &&
  a.sideThreads.every((side) => Boolean(a.rootIds?.has(side.id)) === Boolean(b.rootIds?.has(side.id))) &&
  (openTree(a.current) === a.thread.id) === (openTree(b.current) === b.thread.id) &&
  a.projects.find((p) => p.id === a.thread.projectId) === b.projects.find((p) => p.id === b.thread.projectId) &&
  a.workers.find((w) => w.id === a.thread.workerId) === b.workers.find((w) => w.id === b.thread.workerId);

export const SidebarThreadTreeRow = memo(SidebarThreadTree, sameTree);

/** One tree owns its side rows and attention, including when the same tree is pinned or archived. */
function SidebarThreadTree({
  thread,
  sideThreads,
  rootIds,
  current,
  projects,
  workers,
  archived = false,
  snoozed = false,
  showSides = false,
  reorder = false,
  groupedProject = false,
  groupedWorktree = false,
}: TreeProps) {
  const { sides, subagentsNeedingInput } = sidebarChildren(sideThreads, rootIds);
  const type = useSidebarTypography();
  const [expanded, setExpanded] = useState<boolean>();
  const [previousOpen, setPreviousOpen] = useState(false);
  const open = showSides || (expanded ?? (archived || openTree(current) === thread.id));
  const entering = useReducedMotion() ? undefined : revealSides;
  const c = useColors("sidebar-list");
  const hasSides = sides.active.length + sides.previous.length > 0;

  const headingStyle = ({ pressed }: { pressed: boolean }) => [
    styles.row,
    {
      minHeight: 48,
      gap: 4,
      paddingHorizontal: 8,
      borderRadius: 6,
      backgroundColor: pressed ? c.pressed : "transparent",
    },
  ];

  return (
    <View>
      <ThreadArchiveSwipe thread={thread}>
        <SidebarThread
          thread={thread}
          snoozed={snoozed}
          project={projects.find((p) => p.id === thread.projectId)}
          worker={workers.find((w) => w.id === thread.workerId)}
          subagentsNeedingInput={archived ? [] : subagentsNeedingInput}
          reorder={reorder}
          groupedProject={groupedProject}
          groupedWorktree={groupedWorktree}
        />
      </ThreadArchiveSwipe>
      {hasSides && (
        <View style={{ paddingLeft: 20, paddingBottom: 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Side threads of ${thread.title}`}
            accessibilityState={{ expanded: open, disabled: showSides }}
            disabled={showSides}
            onPress={() => setExpanded(!open)}
            style={headingStyle}
          >
            <Chevron open={open} size={16} />
            <Text numberOfLines={1} style={[type.meta, { flexShrink: 1, color: c.muted }]}>
              {sides.active.length
                ? `${sides.active.length} side ${sides.active.length === 1 ? "thread" : "threads"}`
                : "Side threads"}
            </Text>
          </Pressable>
          {open && (
            <Animated.View
              entering={expanded === true ? entering : undefined}
              style={{ borderLeftWidth: 1, borderColor: c.rule, paddingLeft: 6 }}
            >
              {sides.active.map((side) => (
                <ThreadArchiveSwipe key={side.id} thread={side}>
                  <SidebarSideThread thread={side} snoozed={snoozed} />
                </ThreadArchiveSwipe>
              ))}
              {sides.previous.length > 0 && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: previousOpen }}
                    onPress={() => setPreviousOpen((current) => !current)}
                    style={headingStyle}
                  >
                    <Chevron open={previousOpen} size={16} />
                    <Text numberOfLines={1} style={[type.meta, { flexShrink: 1, color: c.muted }]}>
                      Previous agents · {sides.previous.length}
                    </Text>
                  </Pressable>
                  {previousOpen && (
                    <Animated.View entering={entering}>
                      {sides.previous.map((side) => (
                        <ThreadArchiveSwipe key={side.id} thread={side}>
                          <SidebarSideThread thread={side} snoozed={snoozed} previous />
                        </ThreadArchiveSwipe>
                      ))}
                    </Animated.View>
                  )}
                </>
              )}
            </Animated.View>
          )}
        </View>
      )}
    </View>
  );
}

function SidebarSideThread({
  thread,
  previous = false,
  snoozed = false,
}: {
  thread: ui.Thread;
  previous?: boolean;
  snoozed?: boolean;
}) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const home = useComputerHome(thread.nodeId);
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;
  const [actions, setActions] = useState<boolean>();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  const label =
    snoozed && !previous
      ? "Snoozed"
      : home.away
        ? "Read-only"
        : previous
          ? formatAge(thread.archivedAt)
          : threadRowLabel(thread);

  const unread = !snoozed && thread.markedUnread;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${thread.title || "Untitled thread"}${label ? `, ${label}` : ""}${home.away ? `, ${home.reason}` : ""}${unread ? ", Unread" : ""}`}
        accessibilityState={{ selected: active }}
        onPress={() => void layout.openThread(thread.id)}
        onLongPress={previous ? undefined : () => setActions(true)}
        onFocus={snoozed ? () => setFocused(true) : undefined}
        onBlur={snoozed ? () => setFocused(false) : undefined}
        onHoverIn={snoozed ? () => setHovered(true) : undefined}
        onHoverOut={snoozed ? () => setHovered(false) : undefined}
        accessibilityHint={previous ? undefined : "Hold for thread actions."}
        accessibilityActions={previous ? undefined : [{ name: "longpress", label: "Thread actions" }]}
        onAccessibilityAction={(event) => {
          if (!previous && event.nativeEvent.actionName === "longpress") setActions(true);
        }}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: 48,
            borderRadius: 8,
            paddingHorizontal: 8,
            opacity: home.away ? 0.55 : 1,
            backgroundColor:
              pressed || active ? c.inset : !snoozed && !home.away && isCalm(thread) ? c.well : "transparent",
          },
        ]}
      >
        {({ pressed }) => (
          <>
            <SidebarActivity
              thread={thread}
              away={home.away}
              snoozed={snoozed}
              size={16}
              idle={
                <Icon
                  name={thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right"}
                  size={16}
                  color={c.muted}
                />
              }
            />
            <Text
              numberOfLines={1}
              style={[
                type.title,
                {
                  flex: 1,
                  minWidth: 0,
                  color: snoozed && !(active || actions || focused || hovered || pressed) ? c.muted : c.body,
                },
              ]}
            >
              {thread.title || "Untitled thread"}
            </Text>
            <View style={{ width: 96 }}>
              <SidebarThreadStatus
                thread={thread}
                label={home.away && !snoozed ? "Read-only" : undefined}
                previous={previous}
                snoozed={snoozed}
              />
            </View>
            <SidebarUnread unread={unread} />
          </>
        )}
      </Pressable>
      {actions !== undefined && (
        <ThreadActionsSheet thread={thread} visible={actions} onClose={() => setActions(false)} />
      )}
    </>
  );
}
