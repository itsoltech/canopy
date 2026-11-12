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
}: {
  thread: ui.Thread;
  label?: string;
  previous?: boolean;
}) {
  const c = useColors();
  const type = useSidebarTypography();
  const state = workState(thread);
  const format = useCallback(
    (now: number) => label ?? (previous ? formatAge(thread.archivedAt, now) : threadRowLabel(thread, now)),
    [thread, label, previous],
  );
  const timed =
    previous ||
    state === "running" ||
    ((state === "idle" || state === "background") && !thread.unseenResult && thread.status !== "failed");
  const text = useTimeLabel(format, label === undefined && timed);
  const tone =
    label !== undefined
      ? label === "Read-only"
        ? c.muted
        : c.warning
      : previous
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
