import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import type { ui } from "@canopy/contracts";
import { sidebarChildren } from "@canopy/domain/sidebar-threads";
import { isSide } from "@canopy/domain/thread-tree";
import { needsYou } from "@canopy/domain/thread-activity";
import { useLayout } from "../../state/layout";
import { styles, useColors } from "../../ui/theme";
import { Chevron, Expand } from "../../ui/MotionViews";
import { Icon } from "../../ui/Icon";
import { SidebarThread, age } from "./SidebarThread";
import { useComputerHome } from "../computers/presence";
import { SidebarUnread } from "./SidebarUnread";

/** One tree owns its side rows and attention, including when the same tree is pinned or archived. */
export function SidebarThreadTree({
  thread,
  sideThreads,
  rootIds,
  current,
  projects,
  workers,
  archived = false,
}: {
  thread: ui.Thread;
  sideThreads: readonly ui.Thread[];
  rootIds?: ReadonlySet<string>;
  current?: ui.Thread;
  projects: ui.Project[];
  workers: ui.Worker[];
  archived?: boolean;
}) {
  const { sides, subagentsNeedingInput } = sidebarChildren(sideThreads, rootIds);
  const openTree = current && (isSide(current) ? current.parentThreadId : current.id);
  const [expanded, setExpanded] = useState<boolean>();
  const [previousOpen, setPreviousOpen] = useState(false);
  const open = expanded ?? (archived || openTree === thread.id);
  const c = useColors();
  const hasSides = sides.active.length + sides.previous.length > 0;

  return (
    <View>
      <SidebarThread
        thread={thread}
        project={projects.find((p) => p.id === thread.projectId)}
        worker={workers.find((w) => w.id === thread.workerId)}
        subagentsNeedingInput={archived ? [] : subagentsNeedingInput}
      />
      {hasSides && (
        <View style={{ paddingLeft: 20, paddingBottom: 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Side threads of ${thread.title}`}
            accessibilityState={{ expanded: open }}
            onPress={() => setExpanded(!open)}
            style={[styles.row, { minHeight: 48, gap: 4, paddingHorizontal: 8 }]}
          >
            <Chevron open={open} size={14} />
            <Text numberOfLines={1} style={[styles.chromeMeta, { flexShrink: 1, color: c.muted }]}>
              {sides.active.length
                ? `${sides.active.length} side ${sides.active.length === 1 ? "thread" : "threads"}`
                : "Side threads"}
            </Text>
          </Pressable>
          <Expand open={open}>
            <View style={{ borderLeftWidth: 1, borderColor: c.rule, paddingLeft: 6 }}>
              {sides.active.map((side) => (
                <SidebarSideThread key={side.id} thread={side} />
              ))}
              {sides.previous.length > 0 && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: previousOpen }}
                    onPress={() => setPreviousOpen(!previousOpen)}
                    style={[styles.row, { minHeight: 48, gap: 4, paddingHorizontal: 8 }]}
                  >
                    <Chevron open={previousOpen} size={14} />
                    <Text numberOfLines={1} style={[styles.chromeMeta, { flexShrink: 1, color: c.muted }]}>
                      Previous agents · {sides.previous.length}
                    </Text>
                  </Pressable>
                  <Expand open={previousOpen}>
                    {sides.previous.map((side) => (
                      <SidebarSideThread key={side.id} thread={side} previous />
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
  const home = useComputerHome(thread.nodeId);
  const layout = useLayout();
  const pathname = usePathname();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const active = layout.wide && pathname.startsWith("/thread/") && id === thread.id;
  const needs = !home.away && needsYou(thread);
  const busy = !home.away && (thread.status === "running" || thread.status === "creating");
  const result = thread.unseenResult;

  const label = home.away
    ? "Read-only"
    : previous
      ? age(thread.archivedAt?.seconds)
      : needs
        ? "Needs input"
        : busy
          ? thread.status === "creating"
            ? "Starting"
            : "Working"
          : result
            ? result[0]!.toUpperCase() + result.slice(1)
            : "";

  const tone = home.away
    ? c.muted
    : needs
      ? c.warning
      : busy
        ? c.sky
        : result === "failed"
          ? c.danger
          : result === "completed"
            ? c.success
            : c.muted;

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
          backgroundColor: pressed || active ? c.inset : "transparent",
        },
      ]}
    >
      <Icon
        name={
          needs
            ? "hand-raised"
            : busy
              ? "arrow-path"
              : thread.forkSourceThreadId
                ? "square-2-stack"
                : "arrow-turn-down-right"
        }
        size={14}
        color={tone}
      />
      <Text numberOfLines={1} style={[styles.chrome, { flex: 1, minWidth: 0, color: c.body }]}>
        {thread.title || "Untitled thread"}
      </Text>
      <Text numberOfLines={1} style={[styles.chromeMeta, { width: 96, textAlign: "right", color: tone }]}>
        {label}
      </Text>
      <SidebarUnread unread={thread.markedUnread} />
    </Pressable>
  );
}
