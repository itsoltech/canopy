import { useCallback } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatAge } from "@canopy/domain/format";
import { threadRowLabel, workState } from "@canopy/domain/thread-activity";
import { useTimeLabel } from "../../ui/time";
import { useColors } from "../../ui/theme";
import { useSidebarTypography } from "./sidebar-scale";

/** Only this text subscribes to the shared clock, and only changing labels render. The row stays untouched. */
export function SidebarThreadStatus({
  thread,
  label,
  previous = false,
  snoozed = false,
}: {
  thread: ui.Thread;
  label?: string;
  previous?: boolean;
  snoozed?: boolean;
}) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const state = workState(thread);

  const format = useCallback(
    (now: number) => {
      if (label !== undefined) return label;

      if (previous) return formatAge(thread.archivedAt, now);

      if (snoozed) return "Snoozed";

      return threadRowLabel(thread, now);
    },
    [thread, label, previous, snoozed],
  );

  const timed =
    previous ||
    state === "running" ||
    ((state === "idle" || state === "background") && !thread.unseenResult && thread.status !== "failed");

  const text = useTimeLabel(format, label === undefined && (!snoozed || previous) && timed);

  const tone =
    label !== undefined
      ? label === "Read-only"
        ? c.muted
        : c.warning
      : previous || snoozed
        ? c.muted
        : state === "needs"
          ? c.warning
          : state === "asks"
            ? c.agent
            : state === "starting" || state === "running"
              ? c.working.text
              : thread.unseenResult === "completed"
                ? c.success
                : thread.status === "failed" || thread.unseenResult === "failed"
                  ? c.danger
                  : thread.unseenResult === "interrupted"
                    ? c.interrupted
                    : c.muted;

  return (
    <Text numberOfLines={1} style={[type.meta, { color: tone, textAlign: "right", fontVariant: ["tabular-nums"] }]}>
      {text}
    </Text>
  );
}
