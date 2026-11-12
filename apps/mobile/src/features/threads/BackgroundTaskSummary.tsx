import { Text, View } from "react-native";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus, type BackgroundTask } from "@canopy/contracts";
import { backgroundTitle } from "@canopy/domain/background-tasks";
import { formatAge, formatRelative, formatSpan } from "@canopy/domain/format";
import { useTimeLabel } from "../../ui/time";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import { StatusDot } from "../../ui/Badge";

export function BackgroundTaskSummary({
  task,
  status,
  compact,
}: {
  task: BackgroundTask;
  status: ItemStatus;
  compact: boolean;
}) {
  const c = useColors();
  const running = status === ItemStatus.IN_PROGRESS;
  const failed = status === ItemStatus.FAILED || task.stopReason === "error";
  const stopped = status === ItemStatus.INTERRUPTED || (!!task.stopReason && !failed);

  return (
    <View style={[styles.row, { minHeight: 44, paddingHorizontal: 8, gap: 8 }]}>
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        {running ? (
          <StatusDot tone="sky" active />
        ) : failed ? (
          <Icon name="exclamation-circle" color={c.danger} />
        ) : stopped ? (
          <Icon name="stop" />
        ) : status === ItemStatus.COMPLETED ? (
          <Icon name="check-circle" color={c.success} />
        ) : (
          <StatusDot tone="neutral" />
        )}
      </View>
      <Text
        numberOfLines={1}
        style={[compact ? styles.overlay : styles.chrome, { flex: 1, minWidth: 0, color: c.soft }]}
      >
        {backgroundTitle(task, "Background task")}
      </Text>
      <View style={{ paddingRight: running ? 36 : 0 }}>
        <BackgroundTaskMetadata task={task} running={running} />
      </View>
    </View>
  );
}

/** Only metadata subscribes to the clock; the task row and its controls stay still. */
function BackgroundTaskMetadata({ task, running }: { task: BackgroundTask; running: boolean }) {
  const c = useColors();
  const ended = !running ? task.endedAt : undefined;

  const duration = (now: number) =>
    task.startedAt && (running || ended)
      ? formatSpan(Math.max(0, (ended ? timestampMs(ended) : now) - timestampMs(task.startedAt)))
      : "";

  const label = useTimeLabel((now) => {
    const age = formatAge(ended, now);

    return [duration(now), age && (age === "now" ? "now" : `${age} ago`)].filter(Boolean).join(" · ");
  }, running || !!ended);

  return (
    <Text
      accessibilityLabel={[
        duration(Date.now()) && `Duration ${duration(Date.now())}`,
        ended && `Ended ${formatRelative(ended)}`,
      ]
        .filter(Boolean)
        .join(". ")}
      numberOfLines={1}
      style={[styles.chromeMeta, { color: c.muted, textAlign: "right", fontVariant: ["tabular-nums"] }]}
    >
      {label}
    </Text>
  );
}
