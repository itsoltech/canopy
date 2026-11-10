import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { ItemStatus, type ui } from "@canopy/contracts";
import { StatusDot } from "../../../ui/Badge";
import { raised } from "../../../ui/Button";
import { Sheet } from "../../../ui/components";
import { Icon } from "../../../ui/Icon";
import { useMotion } from "../../../ui/motion";
import { styles, useColors } from "../../../ui/theme";
import { TaskRow } from "../ThreadBackgroundTasks";

/** The thread's own background tasks still running, oldest first (web: ThreadState.backgroundTasks). */
export function runningTasks(snapshot: ui.ThreadSnapshot | undefined): ui.TimelineItem[] {
  return (snapshot?.items ?? []).filter(
    (entry) =>
      !entry.inherited && entry.item?.content.case === "backgroundTask" && entry.item.status === ItemStatus.IN_PROGRESS,
  );
}

/**
 * "N running in background" above the composer (web: BackgroundTasksChip), on the left edge: it opens the running
 * tasks with their output and Stop; the sheet closes with the last one. It pops in and out without moving the
 * composer.
 */
export function BackgroundTasksChip({
  tasks,
  threadId,
  disabled,
}: {
  tasks: readonly ui.TimelineItem[];
  threadId: string;
  disabled: boolean;
}) {
  const c = useColors();
  const { pop } = useMotion();
  const [open, setOpen] = useState(false);
  const label = `${tasks.length} running in background`;

  // The sheet closes with the last task and never reopens by itself for a later one.
  if (!tasks.length && open) setOpen(false);

  return (
    <>
      {tasks.length > 0 && (
        <Animated.View entering={pop.entering} exiting={pop.exiting} style={{ alignSelf: "flex-start" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label}. Show tasks`}
            hitSlop={4}
            onPress={() => setOpen(true)}
            style={({ pressed }) => [
              styles.row,
              {
                minHeight: 36,
                gap: 6,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 18,
                backgroundColor: pressed ? c.controlPressed : c.dark ? c.surface : c.control,
              },
              raised(c),
            ]}
          >
            <StatusDot tone="sky" active />
            <Text numberOfLines={1} style={[styles.meta, { color: c.soft, fontVariant: ["tabular-nums"] }]}>
              {label}
            </Text>
            <Icon name={tasks.length === 1 ? "command-line" : "chevron-up-down"} size={14} color={c.faint} />
          </Pressable>
        </Animated.View>
      )}
      <Sheet title="Background tasks" visible={open} onClose={() => setOpen(false)}>
        <View style={{ gap: 12 }}>
          {tasks.map((entry) => (
            <TaskRow key={entry.item?.itemId} entry={entry} threadId={threadId} disabled={disabled} />
          ))}
        </View>
      </Sheet>
    </>
  );
}
